const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bodyParser = require('body-parser');
const path = require('path');
const sharedsession = require('express-socket.io-session');
const Enmap = require('enmap');
const config = require('./config.json');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    maxHttpBufferSize: 1e8, // Increase if necessary
    pingTimeout: 60000,     // Adjust as needed
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Discord OAuth2 Credentials
const {
    discord_client_id,
    discord_client_secret,
    callback_url,
    session_secret,
    port
} = config;

// Initialize Enmap for storing canvas data
const canvasEnmap = new Enmap({ name: 'canvases' });

// Session middleware configuration
const sessionMiddleware = session({
    secret: session_secret,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 86400000 } // 1 day
});

// Apply middlewares
app.use(sessionMiddleware);
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(passport.initialize());
app.use(passport.session());

// Share session with Socket.IO
io.use(sharedsession(sessionMiddleware, {
    autoSave: true
}));

// Passport serialization
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Configure Discord Strategy
passport.use(new DiscordStrategy({
    clientID: discord_client_id,
    clientSecret: discord_client_secret,
    callbackURL: callback_url,
    scope: ['identify']
},
(accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

// Authentication Routes
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('/');
    }
);

app.get('/auth/status', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ isAuthenticated: true, user: req.user });
    } else {
        res.json({ isAuthenticated: false });
    }
});

app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// In-memory canvas storage
const canvases = new Map();

// Helper: Get current timestamp in seconds
const getCurrentTimestamp = () => Math.floor(Date.now() / 1000);

// Initialize canvases from Enmap
const loadAllCanvases = () => {
    canvasEnmap.forEach((canvas, canvasId) => {
        canvases.set(canvasId, canvas);
        console.log(`Canvas ${canvasId} loaded.`);
    });
};

// Create or retrieve a canvas
const createOrGetCanvas = (canvasId) => {
    let canvas = canvases.get(canvasId);
    if (!canvas) {
        canvas = canvasEnmap.get(canvasId) || {
            id: canvasId,
            edited: false,
            data: {},
            lastAccessed: getCurrentTimestamp(),
            viewers: 0
        };
        canvases.set(canvasId, canvas);
    }
    return canvas;
};

// Periodically save edited canvases to Enmap
const SAVE_INTERVAL = 60000; // 60 seconds
const saveAllCanvases = () => {
    canvases.forEach((canvas, canvasId) => {
        if (canvas.edited) {
            canvasEnmap.set(canvasId, canvas);
            canvas.edited = false;
            console.log(`Canvas ${canvasId} saved.`);
        }
    });
};

// Load existing canvases and set save interval
loadAllCanvases();
setInterval(saveAllCanvases, SAVE_INTERVAL);

// Socket.IO connection handler
io.on('connection', (socket) => {
    console.log('A user connected');

    const session = socket.handshake.session;
    let currentCanvasId = null;

    const isAuthenticated = () => session?.passport?.user;

    // Join a canvas
    socket.on('join-canvas', ({ canvasId }) => {
        if (!canvasId) {
            socket.emit('error', { message: 'Canvas ID is required.' });
            return;
        }

        const canvas = createOrGetCanvas(canvasId);

        if (!isAuthenticated() && Object.keys(canvas.data).length === 0) {
            socket.emit('error', { message: 'Unauthorized. Please log in with Discord.' });
            return;
        }

        // Prevent multiple joins to the same canvas
        if (socket.rooms.has(`canvas-${canvasId}`)) return;

        currentCanvasId = canvasId;
        socket.join(`canvas-${canvasId}`);
        canvas.viewers++;
        canvas.lastAccessed = getCurrentTimestamp();

        socket.emit('init-canvas', { canvasId, canvasData: canvas.data });
        io.emit('update-canvas-list', { canvasList: Array.from(canvases.keys()) });

        console.log(`User ${session.id} joined canvas ${canvasId}`);
    });

    // Leave a canvas
    socket.on('leave-canvas', ({ canvasId }) => {
        if (!canvasId || !canvases.has(canvasId)) return;

        const canvas = canvases.get(canvasId);
        if (socket.rooms.has(`canvas-${canvasId}`)) {
            socket.leave(`canvas-${canvasId}`);
            canvas.viewers = Math.max(0, canvas.viewers - 1);
            currentCanvasId = null;

            console.log(`User ${session.id} left canvas ${canvasId}`);
        }
    });

    // Handle drawing
    socket.on('draw', (data) => {
        const { canvasId, x, y, color, size, extra_data } = data;

        if (!isAuthenticated()) {
            socket.emit('error', { message: 'Unauthorized. Please log in with Discord.' });
            return;
        }

        if (!canvasId || !canvases.has(canvasId)) {
            socket.emit('error', { message: 'Canvas does not exist.' });
            return;
        }

        const canvas = canvases.get(canvasId);
        canvas.edited = true;
        canvas.lastAccessed = getCurrentTimestamp();

        const user = {
            id: session.passport.user.id,
            username: session.passport.user.username
        };

        const radius = size / 2;
        const radiusSquared = radius * radius;
        const center = radius - 0.5;

        const canvasData = canvas.data;
        const timestamp = Date.now();

        for (let yOffset = 0; yOffset < size; yOffset++) {
            for (let xOffset = 0; xOffset < size; xOffset++) {
                const dx = xOffset - center;
                const dy = yOffset - center;
                if ((dx * dx) + (dy * dy) < radiusSquared) {
                    const pixelX = x + xOffset - Math.floor(radius) + 1;
                    const pixelY = y + yOffset - Math.floor(radius) + 1;
                    const key = `${pixelX},${pixelY}`;

                    if (extra_data?.targetColor) {
                        const existingPixel = canvasData[key];
                        if ((existingPixel && existingPixel.color !== extra_data.targetColor) ||
                            (!existingPixel && extra_data.targetColor !== "#ffffff")) {
                            continue;
                        }
                    }

                    canvasData[key] = { color, user, timestamp };
                }
            }
        }

        const pixelInfo = { color, user, timestamp };
        io.to(`canvas-${canvasId}`).emit('draw', { canvasId, pixelInfo });
    });

    // Handle canvas save (optional)
    socket.on('save-canvas', ({ canvasId, canvasData }) => {
        if (!canvasId || !canvases.has(canvasId)) return;

        const canvas = canvases.get(canvasId);
        canvas.data = canvasData;
        canvas.edited = true;
        canvas.lastAccessed = getCurrentTimestamp();
    });

    // Provide canvas list
    socket.on('request-canvas-list', () => {
        socket.emit('update-canvas-list', { canvasList: Array.from(canvases.keys()) });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        if (currentCanvasId && canvases.has(currentCanvasId)) {
            const canvas = canvases.get(currentCanvasId);
            canvas.viewers = Math.max(0, canvas.viewers - 1);
        }
        console.log('A user disconnected');
    });
});

// Start the server
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
