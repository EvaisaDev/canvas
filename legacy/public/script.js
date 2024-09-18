// script.js

// Initialize Socket.IO
const socket = io();

// Canvas Setup
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Loading Indicator
const loadingIndicator = document.getElementById('loading-indicator');

// Disable anti-aliasing for pixel-perfect rendering
ctx.imageSmoothingEnabled = false;

// Transform variables for zoom and pan
let scale = 1;
let panX = 0;
let panY = 0;

// Drawing state
let drawing = false;
let currentTool = null;
let currentColor = '#FFB3BA'; // Default color
let pencilSize = 1;

// Authentication state
let isAuthenticated = false;
let userInfo = null;

// Canvas data
let canvasData = {}; // Local copy of the canvas
let canvasId = null; // Current canvas ID
let canvasIndex = 0; // Current canvas index
let isCanvasEdited = false; // Tracks if the canvas has been edited
let canvasList = []; // List of existing canvas IDs

// Tooltip timeout
let hoverTimeout = null;

// Panning state
let isPanning = false;
let startPan = { x: 0, y: 0 };

// Variables to track Spacebar for panning
let spacePressed = false;

// Tooltip Element
const tooltip = document.getElementById('pixel-tooltip');

// Classes for Tools

// Base Tool Class
class Tool {
    constructor(name) {
        this.name = name;
    }

    onMouseDown(e) {}
    onMouseMove(e) {}
    onMouseUp(e) {}
}

// Pencil Tool
class PencilTool extends Tool {
    constructor(name, canvas, ctx) {
        super(name);
        this.canvas = canvas;
        this.ctx = ctx;
    }

    onMouseDown(e) {
        if (!isAuthenticated) {
            alert('You must be logged in with Discord to draw on the canvas.');
            return;
        }
        drawing = true;
        this.draw(e);
    }

    onMouseMove(e) {
        if (drawing) {
            this.draw(e);
        }
    }

    onMouseUp(e) {
        if (drawing) {
            drawing = false;
        }
    }

    draw(e) {
        // If no canvasId is set, attempt to create a new one
        if (!canvasId) {
            if (canvasList.length >= 3) {
                alert('Maximum of 3 canvases reached.');
                return;
            }
            canvasId = generateCanvasId();
            canvasList.push(canvasId);
            updateURL(canvasId);
            updateCanvasIndicators();
            // Notify server to create and join the new canvas
            socket.emit('join-canvas', { canvasId });
        }

        isCanvasEdited = true; // Mark canvas as edited
        const { x, y } = getCanvasCoordinates(e);

        const drawColor = currentTool === 'eraser' ? '#FFFFFF' : currentColor;
        this.ctx.fillStyle = drawColor;

        // Disable anti-aliasing
        this.ctx.imageSmoothingEnabled = false;

        if (pencilSize >= 3) {
            // Draw a pixelated circle
            drawCircle(this.ctx, x, y, pencilSize / 2);
        } else if (pencilSize === 2) {
            // Draw plus shape
            drawPlusShape(this.ctx, x, y);
        } else {
            // Draw single pixel
            this.ctx.fillRect(x, y, 1, 1);
        }

        // Update local canvas data
        updateCanvasData(x, y, drawColor, pencilSize);

        // Emit draw event to the server
        socket.emit('draw-pixel', { canvasId, x, y, color: drawColor, size: pencilSize, tool: currentTool });
    }
}

// Eraser Tool
class EraserTool extends Tool {
    constructor(name, canvas, ctx) {
        super(name);
        this.canvas = canvas;
        this.ctx = ctx;
    }

    onMouseDown(e) {
        if (!isAuthenticated) {
            alert('You must be logged in with Discord to use the eraser.');
            return;
        }
        drawing = true;
        this.erase(e);
    }

    onMouseMove(e) {
        if (drawing) {
            this.erase(e);
        }
    }

    onMouseUp(e) {
        if (drawing) {
            drawing = false;
        }
    }

    erase(e) {
        // If no canvasId is set, attempt to create a new one
        if (!canvasId) {
            if (canvasList.length >= 3) {
                alert('Maximum of 3 canvases reached.');
                return;
            }
            canvasId = generateCanvasId();
            canvasList.push(canvasId);
            updateURL(canvasId);
            updateCanvasIndicators();
            // Notify server to create and join the new canvas
            socket.emit('join-canvas', { canvasId });
        }

        isCanvasEdited = true; // Mark canvas as edited
        const { x, y } = getCanvasCoordinates(e);

        const eraseColor = '#FFFFFF';
        this.ctx.fillStyle = eraseColor;

        // Disable anti-aliasing
        this.ctx.imageSmoothingEnabled = false;

        if (pencilSize >= 3) {
            // Draw a pixelated circle
            drawCircle(this.ctx, x, y, pencilSize / 2);
        } else if (pencilSize === 2) {
            // Draw plus shape
            drawPlusShape(this.ctx, x, y);
        } else {
            // Draw single pixel
            this.ctx.fillRect(x, y, 1, 1);
        }

        // Update local canvas data
        updateCanvasData(x, y, eraseColor, pencilSize);

        // Emit erase event to the server
        socket.emit('draw-pixel', { canvasId, x, y, color: eraseColor, size: pencilSize, tool: 'eraser' });
    }
}

// Fill Tool
class FillTool extends Tool {
    constructor(name, canvas, ctx) {
        super(name);
        this.canvas = canvas;
        this.ctx = ctx;
    }

    onMouseDown(e) {
        if (!isAuthenticated) {
            alert('You must be logged in with Discord to use the fill tool.');
            return;
        }
        this.fill(e);
    }

    onMouseMove(e) {}
    onMouseUp(e) {}

    fill(e) {
        // If no canvasId is set, attempt to create a new one
        if (!canvasId) {
            if (canvasList.length >= 3) {
                alert('Maximum of 3 canvases reached.');
                return;
            }
            canvasId = generateCanvasId();
            canvasList.push(canvasId);
            updateURL(canvasId);
            updateCanvasIndicators();
            // Notify server to create and join the new canvas
            socket.emit('join-canvas', { canvasId });
        }

        isCanvasEdited = true; // Mark canvas as edited
        const { x, y } = getCanvasCoordinates(e);

        const targetColor = getPixelColor(x, y);
        if (targetColor === currentColor) return; // Avoid unnecessary fill

        floodFill(x, y, targetColor, currentColor);

        // Emit fill event to the server
        socket.emit('fill', { canvasId, x, y, targetColor, newColor: currentColor });
    }
}

// Color Picker Tool
class ColorPickerTool extends Tool {
    constructor(name, canvas, ctx) {
        super(name);
        this.canvas = canvas;
        this.ctx = ctx;
    }

    onMouseDown(e) {
        this.pickColor(e);
    }

    onMouseMove(e) {}
    onMouseUp(e) {}

    pickColor(e) {
        const { x, y } = getCanvasCoordinates(e);
        const color = getPixelColor(x, y);
        currentColor = color;

        // Update selected color swatch
        const swatches = document.querySelectorAll('.color-swatch');
        swatches.forEach(swatch => {
            swatch.classList.remove('selected');
            if (swatch.getAttribute('data-color').toLowerCase() === color.toLowerCase()) {
                swatch.classList.add('selected');
            }
        });
    }
}

// Initialize Tools
const tools = {
    'pencil': new PencilTool('pencil', canvas, ctx),
    'eraser': new EraserTool('eraser', canvas, ctx),
    'fill': new FillTool('fill', canvas, ctx),
    'color-picker': new ColorPickerTool('color-picker', canvas, ctx)
};

// Set default tool
currentTool = 'pencil';
document.getElementById('pencil-tool').classList.add('selected');

// Authentication and User Info Handling

// Update Login/Logout UI
function updateLoginStatusUI() {
    const loginButton = document.getElementById('login-button');
    const logoutButton = document.getElementById('logout-button');
    const userInfoSpan = document.getElementById('user-info');

    if (isAuthenticated) {
        loginButton.style.display = 'none';
        logoutButton.style.display = 'flex';
        logoutButton.style.alignItems = 'center';
        logoutButton.style.justifyContent = 'center';
        userInfoSpan.innerHTML = `<i class="fas fa-user-circle"></i>&nbsp;Logged in as&nbsp;<strong>${userInfo.username}</strong>`;
    } else {
        loginButton.style.display = 'flex';
        loginButton.style.alignItems = 'center';
        loginButton.style.justifyContent = 'center';
        logoutButton.style.display = 'none';
        userInfoSpan.innerHTML = '';
    }
}

// Fetch Authentication Status from Server
function fetchAuthStatus() {
    fetch('/auth/status')
        .then(response => response.json())
        .then(data => {
            isAuthenticated = data.isAuthenticated;
            userInfo = data.user;
            updateLoginStatusUI();
            if (!isAuthenticated) {
                alert('You must be logged in with Discord to draw on the canvas.');
            }
        })
        .catch(err => console.error('Error fetching auth status:', err));
}

// Get canvasId from URL parameters
function getCanvasIdFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('canvasId');
}

// Update Browser URL with new canvasId
function updateURL(newCanvasId) {
    const params = new URLSearchParams(window.location.search);
    params.set('canvasId', newCanvasId);
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
}

// Initialize on Page Load
window.onload = () => {
    fetchAuthStatus();

    canvasId = getCanvasIdFromURL();
    if (!canvasId) {
        if (canvasList.length === 0) {
            // No existing canvases, wait for user to draw to create one
            console.log('No existing canvases. Please draw to create the first canvas.');
        } else {
            // Assign to the first existing canvas
            canvasId = canvasList[0];
            canvasIndex = 0;
            updateURL(canvasId);
            loadCanvas(canvasId);
        }
    } else {
        // Join the specified canvas
        loadCanvas(canvasId);
    }

    // Initialize canvas indicators
    updateCanvasIndicators();
};

// Event Listeners for Tool Selection
document.querySelectorAll('.tool-button').forEach(button => {
    button.addEventListener('click', () => {
        // Remove 'selected' class from all tools
        document.querySelectorAll('.tool-button').forEach(btn => btn.classList.remove('selected'));
        // Add 'selected' class to the clicked tool
        button.classList.add('selected');
        // Set current tool
        currentTool = button.id.replace('-tool', '');
    });
});

// Event Listener for Color Selection
const colorSwatches = document.querySelectorAll('.color-swatch');
colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', (e) => {
        colorSwatches.forEach(s => s.classList.remove('selected'));
        e.target.classList.add('selected');
        currentColor = e.target.getAttribute('data-color');
    });
});

// Event Listener for Pencil Size Slider
const pencilSizeDisplay = document.getElementById('pencil-size-display');
const pencilSizeSlider = document.getElementById('pencil-size-slider');

pencilSizeSlider.addEventListener('input', (e) => {
    pencilSize = parseInt(e.target.value);
    pencilSizeDisplay.textContent = pencilSize;
});

// Event Listener for Canvas Mouse Events
canvas.addEventListener('mousedown', (e) => {
    if (e.button === 1 || (e.button === 0 && spacePressed)) {
        // Start panning
        isPanning = true;
        startPan = { x: e.clientX - panX, y: e.clientY - panY };
        canvas.classList.add('grabbing');
    } else if (e.button === 0) {
        // Trigger tool's mousedown
        if (tools[currentTool]) {
            tools[currentTool].onMouseDown(e);
        }
    }
});

canvas.addEventListener('mouseup', (e) => {
    if (isPanning) {
        // Stop panning
        isPanning = false;
        canvas.classList.remove('grabbing');
        canvas.style.cursor = spacePressed ? 'grab' : 'crosshair';
    } else {
        // Trigger tool's mouseup
        if (tools[currentTool]) {
            tools[currentTool].onMouseUp(e);
        }
    }
});

canvas.addEventListener('mousemove', (e) => {
    if (isPanning) {
        // Update pan position
        panX = e.clientX - startPan.x;
        panY = e.clientY - startPan.y;
        updateCanvasTransform();
    } else {
        // Trigger tool's mousemove
        if (tools[currentTool]) {
            tools[currentTool].onMouseMove(e);
        }
    }

    // Handle hover for tooltip
    if (hoverTimeout) {
        clearTimeout(hoverTimeout);
    }
    hoverTimeout = setTimeout(() => {
        showPixelInfo(e);
    }, 5000);
});

// Event Listeners for Key Presses (Spacebar for Panning)
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); // Prevent default scrolling behavior
        spacePressed = true;
        if (!isPanning) canvas.classList.add('grab');
    }
});

document.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
        spacePressed = false;
        canvas.classList.remove('grab');
        if (!isPanning) canvas.classList.remove('grabbing');
    }
});

// Handle zoom with mouse wheel
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = (e.clientX - rect.left - panX) / scale;
    const mouseY = (e.clientY - rect.top - panY) / scale;
    const deltaScale = e.deltaY > 0 ? -0.1 : 0.1;
    const newScale = scale + deltaScale;
    if (newScale < 0.5 || newScale > 5) return; // Limit zoom scale

    // Calculate the new pan to keep the mouse position stable
    panX -= (mouseX * deltaScale);
    panY -= (mouseY * deltaScale);

    scale = newScale;
    updateCanvasTransform();
});

// Update canvas transform based on current scale and pan
function updateCanvasTransform() {
    const canvasContainer = document.getElementById('canvas-container');
    canvasContainer.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) scale(${scale})`;
}

// Draw a pixelated circle
function drawCircle(ctx, x, y, radius) {
    radius = Math.floor(radius);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if (dx * dx + dy * dy <= radius * radius) {
                ctx.fillRect(x + dx, y + dy, 1, 1);
            }
        }
    }
}

// Draw a plus shape for size 2
function drawPlusShape(ctx, x, y) {
    ctx.fillRect(x, y - 1, 1, 3); // Vertical line
    ctx.fillRect(x - 1, y, 3, 1); // Horizontal line
}

// Update canvas data for synchronization
function updateCanvasData(x, y, color, size) {
    const radius = Math.floor(size / 2);
    const timestamp = Date.now();
    const user = userInfo;

    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if (size >= 3) {
                if (dx * dx + dy * dy <= radius * radius) {
                    const pixelX = x + dx;
                    const pixelY = y + dy;
                    if (pixelX >= 0 && pixelX < canvas.width && pixelY >= 0 && pixelY < canvas.height) {
                        const key = `${pixelX},${pixelY}`;
                        canvasData[key] = { color: color, timestamp, user };
                    }
                }
            } else if (size === 2) {
                if (dx === 0 || dy === 0) {
                    const pixelX = x + dx;
                    const pixelY = y + dy;
                    if (pixelX >= 0 && pixelX < canvas.width && pixelY >= 0 && pixelY < canvas.height) {
                        const key = `${pixelX},${pixelY}`;
                        canvasData[key] = { color: color, timestamp, user };
                    }
                }
            } else if (size === 1 && dx === 0 && dy === 0) {
                const key = `${x},${y}`;
                canvasData[key] = { color: color, timestamp, user };
            }
        }
    }
}

// Fill function (already handled by FillTool class)
function fill(e) {
    if (!isAuthenticated) {
        alert('You must be logged in with Discord to use the fill tool.');
        return;
    }
    isCanvasEdited = true; // Mark canvas as edited
    const { x, y } = getCanvasCoordinates(e);

    const targetColor = getPixelColor(x, y);
    if (targetColor === currentColor) return; // Avoid unnecessary fill

    floodFill(x, y, targetColor, currentColor);

    // Emit fill event to the server
    socket.emit('fill', { canvasId, x, y, targetColor, newColor: currentColor });
}

// Flood fill algorithm
function floodFill(x, y, targetColor, newColor) {
    const stack = [];
    stack.push({ x: x, y: y });

    while (stack.length > 0) {
        const { x, y } = stack.pop();
        const key = `${x},${y}`;

        if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;
        if (canvasData[key] && canvasData[key].color !== targetColor) continue;
        if (canvasData[key] && canvasData[key].color === newColor) continue; // Already filled

        ctx.fillStyle = newColor;
        ctx.fillRect(x, y, 1, 1);
        canvasData[key] = { color: newColor, timestamp: Date.now(), user: userInfo };

        stack.push({ x: x + 1, y: y });
        stack.push({ x: x - 1, y: y });
        stack.push({ x: x, y: y + 1 });
        stack.push({ x: x, y: y - 1 });
    }
}

// Get pixel color from canvasData
function getPixelColor(x, y) {
    const key = `${x},${y}`;
    if (canvasData[key]) {
        return canvasData[key].color;
    } else {
        // Default to white if not found
        return '#FFFFFF';
    }
}

// Redraw canvas from canvasData
function redrawCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let key in canvasData) {
        const [x, y] = key.split(',').map(Number);
        ctx.fillStyle = canvasData[key].color;
        ctx.fillRect(x, y, 1, 1);
    }
}

// Canvas Navigation Elements
const canvasIndicators = document.getElementById('canvas-indicators');
const prevCanvasBtn = document.getElementById('prev-canvas');
const nextCanvasBtn = document.getElementById('next-canvas');

// Event Listeners for Canvas Navigation
prevCanvasBtn.addEventListener('click', () => {
    if (canvasIndex > 0) {
        saveCurrentCanvas();
        canvasIndex--;
        canvasId = canvasList[canvasIndex];
        updateURL(canvasId);
        loadCanvas(canvasId);
        updateCanvasIndicators();
    }
});

nextCanvasBtn.addEventListener('click', () => {
    if (canvasIndex < canvasList.length - 1) {
        saveCurrentCanvas();
        canvasIndex++;
        canvasId = canvasList[canvasIndex];
        updateURL(canvasId);
        loadCanvas(canvasId);
        updateCanvasIndicators();
    } else if (canvasList.length < 3) {
        // Create a new canvas
        saveCurrentCanvas();
        canvasId = generateCanvasId();
        canvasList.push(canvasId);
        canvasIndex = canvasList.length - 1;
        updateURL(canvasId);
        // Do not manually clear canvasData or redraw here
        isCanvasEdited = false; // Reset edited flag
        updateCanvasIndicators();
        // Notify server to create and join the new canvas
        socket.emit('join-canvas', { canvasId });
    }
});

// Save current canvas data to the server
function saveCurrentCanvas() {
    if (isCanvasEdited) {
        socket.emit('save-canvas', { canvasId, canvasData });
        isCanvasEdited = false; // Reset the edited flag after saving
    }
}

// Load canvas data from the server
function loadCanvas(id) {
    isCanvasEdited = false;
    // Show loading indicator
    loadingIndicator.style.display = 'flex';
    // Request to join the new canvas
    socket.emit('join-canvas', { canvasId: id });
}

// Update Canvas Indicators (Always 3 indicators)
function updateCanvasIndicators() {
    const indicators = canvasIndicators.querySelectorAll('.indicator');
    indicators.forEach((indicator, index) => {
        // Clear existing classes
        indicator.classList.remove('active');

        if (index < canvasList.length) {
            if (canvasIndex === index) {
                indicator.classList.add('active');
                indicator.innerHTML = '<i class="fas fa-circle"></i>'; // Filled circle
            } else {
                indicator.innerHTML = '<i class="far fa-circle"></i>'; // Empty circle
            }
        } else {
            // For non-existent canvases, show empty circles
            indicator.innerHTML = '<i class="far fa-circle"></i>';
        }
    });
}

// Generate a unique canvas ID (random hashcode)
function generateCanvasId() {
    return Math.random().toString(36).substr(2, 9);
}

// Tooltip Handling
function showPixelInfo(e) {
    const { x, y } = getCanvasCoordinates(e);
    const key = `${x},${y}`;
    if (canvasData[key] && canvasData[key].user) {
        const info = canvasData[key];
        tooltip.innerHTML = `
            <strong>Placed by:</strong> ${info.user.username}<br>
            <strong>At:</strong> ${new Date(info.timestamp).toLocaleString()}
        `;
        tooltip.style.left = `${e.pageX + 10}px`;
        tooltip.style.top = `${e.pageY + 10}px`;
        tooltip.style.display = 'block';
    }
}

function hidePixelInfo() {
    if (tooltip) {
        tooltip.style.display = 'none';
    }
}

// Socket.IO Event Handlers

// Handle draw-pixel event from server
socket.on('draw-pixel', (data) => {
    if (data.canvasId !== canvasId) return;
    const { x, y, color, size, tool, user, timestamp } = data;
    ctx.fillStyle = color;

    // Disable anti-aliasing
    ctx.imageSmoothingEnabled = false;

    if (size >= 3) {
        // Draw pixelated circle
        drawCircle(ctx, x, y, size / 2);
    } else if (size === 2) {
        // Draw plus shape
        drawPlusShape(ctx, x, y);
    } else {
        // Draw single pixel
        ctx.fillRect(x, y, 1, 1);
    }

    // Update local canvas data
    const radius = Math.floor(size / 2);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if (size >= 3) {
                if (dx * dx + dy * dy <= radius * radius) {
                    const pixelX = x + dx;
                    const pixelY = y + dy;
                    if (pixelX >= 0 && pixelX < canvas.width && pixelY >= 0 && pixelY < canvas.height) {
                        const key = `${pixelX},${pixelY}`;
                        canvasData[key] = { color: color, user, timestamp };
                    }
                }
            } else if (size === 2) {
                if (dx === 0 || dy === 0) {
                    const pixelX = x + dx;
                    const pixelY = y + dy;
                    if (pixelX >= 0 && pixelX < canvas.width && pixelY >= 0 && pixelY < canvas.height) {
                        const key = `${pixelX},${pixelY}`;
                        canvasData[key] = { color: color, user, timestamp };
                    }
                }
            } else if (size === 1 && dx === 0 && dy === 0) {
                const key = `${x},${y}`;
                canvasData[key] = { color: color, user, timestamp };
            }
        }
    }
});

// Handle fill event from server
socket.on('fill', (data) => {
    if (data.canvasId !== canvasId) return;
    const { x, y, targetColor, newColor, user, timestamp } = data;
    floodFill(x, y, targetColor, newColor);

    // Update all filled pixels with user info
    for (let key in canvasData) {
        if (canvasData[key].color === newColor && !canvasData[key].user) {
            canvasData[key].timestamp = timestamp;
            canvasData[key].user = user;
        }
    }

    redrawCanvas();
});

// Handle initial canvas data
socket.on('init-canvas', (data) => {
    if (data.canvasId === canvasId) {
        canvasData = data.canvasData;
        redrawCanvas();
        // Hide loading indicator
        loadingIndicator.style.display = 'none';
    }
});

// Update canvas list from server
socket.on('update-canvas-list', (data) => {
    canvasList = data.canvasList;
    canvasIndex = canvasList.indexOf(canvasId);
    updateCanvasIndicators();
});

// Handle canvas removal
socket.on('canvas-removed', (data) => {
    const { removedCanvasId } = data;
    const removedIndex = canvasList.indexOf(removedCanvasId);
    if (removedIndex !== -1) {
        canvasList.splice(removedIndex, 1);
        if (canvasIndex > removedIndex) {
            canvasIndex--;
        }
        if (canvasId === removedCanvasId) {
            // Load the next available canvas
            canvasId = canvasList[canvasIndex] || canvasList[canvasIndex - 1];
            updateURL(canvasId);
            loadCanvas(canvasId);
        }
        updateCanvasIndicators();
    }
});

// Handle error messages from server
socket.on('error', (data) => {
    alert(data.message);
});

// Handle request for canvas list (if needed)
socket.on('request-canvas-list', () => {
    socket.emit('request-canvas-list');
});

// Utility Functions

// Translate mouse event to canvas coordinates considering zoom and pan
function getCanvasCoordinates(e) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left - panX) / scale);
    const y = Math.floor((e.clientY - rect.top - panY) / scale);
    return { x, y };
}

// Generate a unique canvas ID (random hashcode)
function generateCanvasId() {
    return Math.random().toString(36).substr(2, 9);
}
