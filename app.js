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
const { createCanvas, loadImage } = require('canvas')
const { PassThrough } = require('stream');
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
		
		// create internal canvas reference
		canvas.internalCanvas = createCanvas(512, 512);
		canvas.internalCtx = canvas.internalCanvas.getContext('2d');

		// fill with color
		canvas.internalCtx.fillStyle = "#ffffff";
		canvas.internalCtx.fillRect(0, 0, 512, 512);

		// if imageFileName, check if file exists
		if (canvas.imageFileName) {
			const fs = require('fs');
			if (!fs.existsSync(canvas.imageFileName)) {
				console.log("Image file not found, skipping: ", canvas.imageFileName);
				canvas.imageFileName = null;
			}
		}

		if(canvas.imageFileName){
			console.log("Loading image from file: ", canvas.imageFileName);
			loadImage(canvas.imageFileName).then((image) => {
				canvas.internalCtx.drawImage(image, 0, 0);
			});
		}else{
			// draw all pixels
			for (const key in canvas.data) {
				const pixel = canvas.data[key];
				const [x, y] = key.split(',').map(Number);

				// draw 1x1 pixel without using brush function
				canvas.internalCtx.fillStyle = pixel.color;
				canvas.internalCtx.fillRect(x, y, 1, 1);
			}

			// write image to file with key as name
			const fs = require('fs');
			// create a folder for canvases
			const folder = './canvases';
			if (!fs.existsSync(folder)) {
				fs.mkdirSync(folder);
			}

			canvas.imageFileName = `./canvases/${canvasId.replace("|", "-")}.png`;

			const out = fs.createWriteStream(canvas.imageFileName);
			const stream = canvas.internalCanvas.createPNGStream();
			stream.pipe(out);
			out.on('finish', () =>  console.log('The PNG file was created.'));
			out.on('error', console.error);
		}

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

	// create internal canvas reference
	canvas.internalCanvas = createCanvas(512, 512);
	canvas.internalCtx = canvas.internalCanvas.getContext('2d');

	// fill with color
	canvas.internalCtx.fillStyle = "#ffffff";
	canvas.internalCtx.fillRect(0, 0, 512, 512);

	if(canvas.imageFileName){
		console.log("Loading image from file: ", canvas.imageFileName);
		loadImage(canvas.imageFileName).then((image) => {
			canvas.internalCtx.drawImage(image, 0, 0);
		});
	}else{
		// draw all pixels
		for (const key in canvas.data) {
			const pixel = canvas.data[key];
			const [x, y] = key.split(',').map(Number);

			// draw 1x1 pixel without using brush function
			canvas.internalCtx.fillStyle = pixel.color;
			canvas.internalCtx.fillRect(x, y, 1, 1);
		}

		// write image to file with key as name
		const fs = require('fs');
		// create a folder for canvases
		const folder = './canvases';
		if (!fs.existsSync(folder)) {
			fs.mkdirSync(folder);
		}

		canvas.imageFileName = `./canvases/${canvasId.replace("|", "-")}.png`;

		const out = fs.createWriteStream(canvas.imageFileName);
		const stream = canvas.internalCanvas.createPNGStream();
		stream.pipe(out);
		out.on('finish', () =>  console.log('The PNG file was created.'));
		out.on('error', console.error);
	}

    return canvas;
};

// Periodically save edited canvases to Enmap
const SAVE_INTERVAL = 60000; // 60 seconds
const saveAllCanvases = () => {
    canvases.forEach((canvas, canvasId) => {
        if (canvas.edited) {

			// save to file
			const fs = require('fs');
			const out = fs.createWriteStream(canvas.imageFileName);
			const stream = canvas.internalCanvas.createPNGStream();
			stream.pipe(out);
			out.on('finish', () =>  console.log('The PNG file was created.'));
			out.on('error', console.error);

			// create canvas data, remove internal canvas
			let canvasClone = {...canvas};
			delete canvasClone.internalCanvas;
			delete canvasClone.internalCtx;

            canvasEnmap.set(canvasId, canvasClone);
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
	socket.on('join-canvas', async ({ canvasId }) => {
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
	
		// Ensure the canvas has finished drawing
		// Forcing the canvas to wait for the complete rendering of all drawings if needed
		await new Promise((resolve) => {
			setTimeout(resolve, 100); // Adjust delay if necessary to ensure the canvas has time to render
		});
	
		// Create PNG in-memory stream
		const passthrough = new PassThrough();
		const buffers = [];
	
		passthrough.on('data', (chunk) => buffers.push(chunk));
		passthrough.on('end', () => {
			const binaryImage = Buffer.concat(buffers);
	
			// Emit canvas data with the in-memory image
			socket.emit('init-canvas', { canvasId, canvasData: canvas.data, imageBlob: binaryImage });
			socket.emit('update-canvas-list', { canvasList: Array.from(canvases.keys()) });
	
			console.log(`User ${session.id} joined canvas ${canvasId}`);
		});
	
		passthrough.on('error', (error) => {
			console.error('Error creating PNG stream:', error);
			socket.emit('error', { message: 'Error generating image.' });
		});
	
		// Pipe the canvas PNG stream into the passthrough
		canvas.internalCanvas.createPNGStream().pipe(passthrough);
	});

    // Leave a canvas
    socket.on('leave-canvas', async ({ canvasId }) => {
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
    socket.on('draw', async (data) => {
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

		// Draw on the internal canvas
		drawBrush(canvas.internalCtx, x, y, size, color, canvasId, extra_data?.targetColor);

        const pixelInfo = { color, user, timestamp };
        io.to(`canvas-${canvasId}`).emit('draw', { ...data, user, timestamp });
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

/**
 * Draws a circular brush with configurable pixel size.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {number} x - X-coordinate
 * @param {number} y - Y-coordinate
 * @param {number} size - Radius of the brush
 * @param {string} color - Color to draw
 * @param {string} canvasId - ID of the canvas
 */
function drawBrush(ctx, x, y, size, color, canvasId, targetColor = null) {
    ctx.fillStyle = color;
    const radius = size / 2;
    const center = radius - 0.5;

    for (let yOffset = 0; yOffset < size; yOffset++) {
        for (let xOffset = 0; xOffset < size; xOffset++) {
            const distance = Math.sqrt(Math.pow(xOffset - center, 2) + Math.pow(yOffset - center, 2));
            if (distance < radius) {

				if (targetColor == null) {
                	ctx.fillRect(x + xOffset - radius + 1, y + yOffset - radius + 1, 1, 1);
				} else {
					// only draw if the pixel is the target color
					if (getPixelColor(ctx, x + xOffset - radius + 1, y + yOffset - radius + 1) == targetColor) {
						ctx.fillRect(x + xOffset - radius + 1, y + yOffset - radius + 1, 1, 1);
					}
				}
            }
        }
    }
}

function getPixelColor(ctx, x, y) {
    if (!ctx) return '#FFFFFF';

    try {
        const pixelData = ctx.getImageData(x, y, 1, 1).data;
        return `#${((1 << 24) + (pixelData[0] << 16) + (pixelData[1] << 8) + pixelData[2]).toString(16).slice(1)}`;
    } catch (error) {
        console.error('Error getting pixel color:', error);
        return '#FFFFFF';
    }
}

// Start the server
server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
