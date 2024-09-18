// app.js

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

// Replace with your Discord app credentials from config.json
const DISCORD_CLIENT_ID = config.discord_client_id;
const DISCORD_CLIENT_SECRET = config.discord_client_secret;
const CALLBACK_URL = config.callback_url;

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
    autoSave:true
}));

// Map to store canvas data
const canvases = []; // Array of canvas objects
let canvasList = []; // List of canvas IDs

// Helper function to get current timestamp
function getCurrentTimestamp() {
    return Math.floor(Date.now() / 1000);
}

// Canvas object structure
function createCanvas(canvasId) {
    return {
        id: canvasId,
        edited: false,
        data: {},
        lastAccessed: getCurrentTimestamp(),
        viewers: 0,
    };
}

io.on('connection', (socket) => {
    console.log('A user connected');

    // Access the session
    const session = socket.handshake.session;
    let currentCanvasId = null;

    socket.on('join-canvas', (data) => {
        const { canvasId } = data;
        currentCanvasId = canvasId;

        // Ensure the canvas exists
        let canvas = canvases.find(c => c.id === canvasId);
        if (!canvas) {
            // Check if maximum canvases reached
            if (canvases.length >= 3) {
                socket.emit('error', { message: 'Maximum of 3 canvases reached.' });
                return;
            }
            // Create a new canvas in memory
            canvas = createCanvas(canvasId);
            canvases.push(canvas);
            canvasList.push(canvasId);
        }

        // Update last accessed time and increment viewers
        canvas.lastAccessed = getCurrentTimestamp();
        canvas.viewers++;

        // Send the current canvas data to the user
        socket.join(`canvas-${canvasId}`);
        socket.emit('init-canvas', { canvasId, canvasData: canvas.data });

        // Send updated canvas list to clients
        io.emit('update-canvas-list', { canvasList });
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
        let canvas = canvases.find(c => c.id === canvasId);
        if (!canvas) {
            // Check if maximum canvases reached
            if (canvases.length >= 3) {
                socket.emit('error', { message: 'Maximum of 3 canvases reached. Cannot create a new one.' });
                return;
            }
            // Create a new canvas
            canvas = createCanvas(canvasId);
            canvases.push(canvas);
            canvasList.push(canvasId);
        }

        // Mark canvas as edited
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
                    if (dx * dx + dy * dy <= radius * radius) {
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

        // Broadcast to all other clients on the same canvas
        socket.to(`canvas-${canvasId}`).emit('draw-pixel', data);
    });

    // Listen for fill events
    socket.on('fill', (data) => {
        const { canvasId, x, y, targetColor, newColor } = data;

        // Authentication check
        if (!session.passport || !session.passport.user) {
            socket.emit('error', { message: 'Unauthorized. Please log in with Discord.' });
            return;
        }

        // Ensure the canvas exists
        let canvas = canvases.find(c => c.id === canvasId);
        if (!canvas) {
            // Check if maximum canvases reached
            if (canvases.length >= 3) {
                socket.emit('error', { message: 'Maximum of 3 canvases reached. Cannot create a new one.' });
                return;
            }
            // Create a new canvas
            canvas = createCanvas(canvasId);
            canvases.push(canvas);
            canvasList.push(canvasId);
        }

        // Mark canvas as edited
        canvas.edited = true;
        canvas.lastAccessed = getCurrentTimestamp();

        // Update the canvas data
        const canvasData = canvas.data;
        const timestamp = Date.now();
        const user = {
            id: session.passport.user.id,
            username: session.passport.user.username
        };
        floodFillServer(canvasData, x, y, targetColor, newColor, user, timestamp);

        // Broadcast to all clients on the same canvas
        data.user = user;
        data.timestamp = timestamp;
        io.to(`canvas-${canvasId}`).emit('fill', data);
    });

    // Listen for canvas save events
    socket.on('save-canvas', (data) => {
        const { canvasId, canvasData: newCanvasData } = data;
        let canvas = canvases.find(c => c.id === canvasId);
        if (canvas) {
            canvas.data = newCanvasData;
            canvas.edited = true;
            canvas.lastAccessed = getCurrentTimestamp();
        }
    });

    // Provide the canvas list to clients
    socket.on('request-canvas-list', () => {
        socket.emit('update-canvas-list', { canvasList });
    });

    socket.on('disconnect', () => {
        console.log('A user disconnected');
        if (currentCanvasId !== null) {
            let canvas = canvases.find(c => c.id === currentCanvasId);
            if (canvas) {
                canvas.viewers--;

                // No canvas timeout removal
            }
        }
    });
});

// Server-side flood fill algorithm
function floodFillServer(canvasData, x, y, targetColor, newColor, user, timestamp) {
    const stack = [];
    stack.push({ x: x, y: y });

    while (stack.length > 0) {
        const { x, y } = stack.pop();
        const key = `${x},${y}`;

        if (x < 0 || x >= 512 || y < 0 || y >= 512) continue;
        if (canvasData[key] && canvasData[key].color !== targetColor) continue;
        if (canvasData[key] && canvasData[key].color === newColor) continue; // Already filled

        canvasData[key] = { color: newColor, user, timestamp };

        stack.push({ x: x + 1, y: y });
        stack.push({ x: x - 1, y: y });
        stack.push({ x: x, y: y + 1 });
        stack.push({ x: x, y: y - 1 });
    }
}

// Function to remove a canvas and update indices (Not used since timeout removal is removed)
function removeCanvas(canvasId) {
    const index = canvases.findIndex(c => c.id === canvasId);
    if (index !== -1) {
        canvases.splice(index, 1);
        canvasList.splice(index, 1);
        console.log(`Removed canvas with ID ${canvasId}. Total canvases: ${canvases.length}`);

        // Notify all clients about the removal and updated canvas list
        io.emit('canvas-removed', { removedCanvasId: canvasId });
        io.emit('update-canvas-list', { canvasList });
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
