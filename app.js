const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bodyParser = require('body-parser');
const path = require('path');
const sharedsession = require("express-socket.io-session");
const config = require('./config.json'); // Importing config.json
const Enmap = require('enmap');

// Replace with your Discord app credentials from config.json
const DISCORD_CLIENT_ID = config.discord_client_id;
const DISCORD_CLIENT_SECRET = config.discord_client_secret;
const CALLBACK_URL = config.callback_url;

// Enmap for storing canvas data
const canvasEnmap = new Enmap({ name: 'canvases' });

// Session middleware
const sessionMiddleware = session({
    secret: 'your-session-secret', // Replace with your session secret (use a strong, unique value)
    resave: false,
    saveUninitialized: false
});

app.use(sessionMiddleware);

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Passport serialization
passport.serializeUser((user, done) => {
    done(null, user);
});

passport.deserializeUser((obj, done) => {
    done(null, obj);
});

// Configure Discord Strategy
passport.use(new DiscordStrategy({
    clientID: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    callbackURL: CALLBACK_URL,
    scope: ['identify']
},
(accessToken, refreshToken, profile, done) => {
    process.nextTick(() => {
        return done(null, profile);
    });
}));

// Routes for authentication
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

// Body parser
app.use(bodyParser.json());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Share session with Socket.IO
io.use(sharedsession(sessionMiddleware, {
    autoSave: true
}));

// Map to store canvas data, key: "x-y", value: canvas object
const canvases = new Map();

// Helper function to get current timestamp
function getCurrentTimestamp() {
    return Math.floor(Date.now() / 1000);
}

// Canvas object structure
function createCanvas(canvasId) {
    // Check if the canvas already exists in Enmap
    const savedCanvas = canvasEnmap.get(canvasId);
    if (savedCanvas) {
        return savedCanvas; // Load from Enmap if it exists
    }

    // Otherwise, create a new canvas
    return {
        id: canvasId,
        edited: false,
        data: {}, // key: "x,y", value: { color, user, timestamp }
        lastAccessed: getCurrentTimestamp(),
        viewers: 0,
    };
}

// Save interval setup
const saveInterval = 60000; // Save every 60 seconds
let saveTimeouts = new Map(); // To track timeouts per canvas

// Function to periodically save canvases with changes
function saveAllCanvases() {
    canvases.forEach((canvas, canvasId) => {
        if (canvas.edited) {
            canvasEnmap.set(canvasId, canvas);
            canvas.edited = false; // Mark as saved
            console.log(`Canvas ${canvasId} saved.`);
        }
    });
}

// Set interval to save all canvases periodically
setInterval(saveAllCanvases, saveInterval);

// Canvas expiration and cleanup
const canvasExpirationTime = 3600; // 1 hour

function cleanupInactiveCanvases() {
    const currentTime = getCurrentTimestamp();
    canvases.forEach((canvas, canvasId) => {
        if (currentTime - canvas.lastAccessed > canvasExpirationTime) {
            canvases.delete(canvasId);
            canvasEnmap.delete(canvasId); // Optionally remove from Enmap
            console.log(`Canvas ${canvasId} deleted due to inactivity.`);
        }
    });
}

// Set interval to clean up inactive canvases every 10 minutes
setInterval(cleanupInactiveCanvases, 600000); // 10 minutes

io.on('connection', (socket) => {
    console.log('A user connected');

    // Access the session
    const session = socket.handshake.session;
    let currentCanvasId = null;

    function isAuthenticated() {
        return session && session.passport && session.passport.user;
    }

    // Join a canvas based on canvasId
    socket.on('join-canvas', (data) => {
        const { canvasId } = data;
        currentCanvasId = canvasId;

        // Ensure the canvas exists
        let canvas = canvases.get(canvasId);
        if (!canvas) {
            // Create a new canvas
            canvas = createCanvas(canvasId);

			if(!isAuthenticated() && !canvas.edited){
				// do not allow
				socket.emit('error', { message: 'Unauthorized. Please log in with Discord.' });
				return;
			}
            canvases.set(canvasId, canvas);
        }

        // Update last accessed time and increment viewers
        canvas.lastAccessed = getCurrentTimestamp();
        canvas.viewers++;

        // Join the Socket.IO room for this canvas
        socket.join(`canvas-${canvasId}`);

        // Send the current canvas data to the user
        socket.emit('init-canvas', { canvasId, canvasData: canvas.data });

        // Notify all clients about the updated canvas list
        io.emit('update-canvas-list', { canvasList: Array.from(canvases.keys()) });
    });

    // Listen for drawing events
    socket.on('draw-pixel', (data) => {
        const { canvasId, x, y, color, size, tool } = data;

        // Authentication check
        if (!session.passport || !session.passport.user) {
            socket.emit('error', { message: 'Unauthorized. Please log in with Discord.' });
            return;
        }

        // Ensure the canvas exists
        let canvas = canvases.get(canvasId);
        if (!canvas) {
            // Create a new canvas
            canvas = createCanvas(canvasId);
            canvases.set(canvasId, canvas);
        }

        // Mark canvas as edited and update last accessed
        canvas.edited = true;
        canvas.lastAccessed = getCurrentTimestamp();

        // Update the canvas data
        const canvasData = canvas.data;
        const radius = Math.floor(size / 2);
        const timestamp = Date.now();
        const user = {
            id: session.passport.user.id,
            username: session.passport.user.username
        };

        for (let dx = -radius; dx <= radius; dx++) {
            for (let dy = -radius; dy <= radius; dy++) {
                if (size >= 3) {
                    if (dx * dx + dy * dy <= radius * radius - radius * 0.2) {
                        const pixelX = x + dx;
                        const pixelY = y + dy;
                        const key = `${pixelX},${pixelY}`;
                        canvasData[key] = { color: color, user, timestamp };
                    }
                } else if (size === 2) {
                    if (dx === 0 || dy === 0) {
                        const pixelX = x + dx;
                        const pixelY = y + dy;
                        const key = `${pixelX},${pixelY}`;
                        canvasData[key] = { color: color, user, timestamp };
                    }
                } else if (size === 1 && dx === 0 && dy === 0) {
                    const key = `${x},${y}`;
                    canvasData[key] = { color: color, user, timestamp };
                }
            }
        }

        data.pixelInfo = { color: color, user, timestamp };

        // Broadcast to all other clients in the same canvas
        socket.to(`canvas-${canvasId}`).emit('draw-pixel', data);
    });

    // Listen for canvas save events (optional)
    socket.on('save-canvas', (data) => {
        const { canvasId, canvasData: newCanvasData } = data;
        let canvas = canvases.get(canvasId);
        if (canvas) {
            canvas.data = newCanvasData;
            canvas.edited = true;
            canvas.lastAccessed = getCurrentTimestamp();
        }
    });

    // Provide the canvas list to clients
    socket.on('request-canvas-list', () => {
        socket.emit('update-canvas-list', { canvasList: Array.from(canvases.keys()) });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('A user disconnected');
        if (currentCanvasId !== null) {
            let canvas = canvases.get(currentCanvasId);
            if (canvas) {
                canvas.viewers--;

                // Optionally, implement canvas cleanup based on viewer count or last accessed time
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
