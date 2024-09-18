// script.js

// Initialize Socket.IO
const socket = io();

// Canvas Map Setup
const canvasMap = document.getElementById('canvas-map');
const loadingIndicator = document.getElementById('loading-indicator');

// Tool Setup
let currentTool = 'pencil';
let currentColor = '#FFB3BA'; // Default color
let pencilSize = 1;

// Authentication state
let isAuthenticated = false;
let userInfo = null;

// Map to track existing canvases and their contexts
const canvases = new Map(); // key: 'x-y', value: { canvas, ctx, drawing }

// Tooltip timeout
let hoverTimeout = null;

// Panning and Zooming variables
let isPanning = false;
let startPan = { x: 0, y: 0 };
let currentPan = { x: 0, y: 0 };
let currentZoom = 1;
const minZoom = 0.5;
const maxZoom = 3;

// Tooltip Element
const tooltip = document.getElementById('pixel-tooltip');

// Classes for Tools

// Base Tool Class
class Tool {
    constructor(name) {
        this.name = name;
    }

    onMouseDown(e, canvasObj) {}
    onMouseMove(e, canvasObj) {}
    onMouseUp(e, canvasObj) {}
}

// Pencil Tool
class PencilTool extends Tool {
    constructor(name) {
        super(name);
    }

    onMouseDown(e, canvasObj) {
        if (!isAuthenticated) {
            alert('You must be logged in with Discord to draw on the canvas.');
            return;
        }
        canvasObj.drawing = true;
        this.draw(e, canvasObj);
    }

    onMouseMove(e, canvasObj) {
        if (canvasObj.drawing) {
            this.draw(e, canvasObj);
        }
    }

    onMouseUp(e, canvasObj) {
        if (canvasObj.drawing) {
            canvasObj.drawing = false;
        }
    }

    draw(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const drawColor = currentTool === 'eraser' ? '#FFFFFF' : currentColor;
        canvasObj.ctx.fillStyle = drawColor;
        canvasObj.ctx.imageSmoothingEnabled = false;

        if (pencilSize >= 3) {
            drawCircle(canvasObj.ctx, x, y, pencilSize / 2);
        } else if (pencilSize === 2) {
            drawPlusShape(canvasObj.ctx, x, y);
        } else {
            canvasObj.ctx.fillRect(x, y, 1, 1);
        }

        // Emit draw event to the server
        socket.emit('draw-pixel', { canvasId: canvasObj.id, x, y, color: drawColor, size: pencilSize, tool: currentTool });
    }
}

// Eraser Tool
class EraserTool extends Tool {
    constructor(name) {
        super(name);
    }

    onMouseDown(e, canvasObj) {
        if (!isAuthenticated) {
            alert('You must be logged in with Discord to use the eraser.');
            return;
        }
        canvasObj.drawing = true;
        this.erase(e, canvasObj);
    }

    onMouseMove(e, canvasObj) {
        if (canvasObj.drawing) {
            this.erase(e, canvasObj);
        }
    }

    onMouseUp(e, canvasObj) {
        if (canvasObj.drawing) {
            canvasObj.drawing = false;
        }
    }

    erase(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const eraseColor = '#FFFFFF';
        canvasObj.ctx.fillStyle = eraseColor;
        canvasObj.ctx.imageSmoothingEnabled = false;

        if (pencilSize >= 3) {
            drawCircle(canvasObj.ctx, x, y, pencilSize / 2);
        } else if (pencilSize === 2) {
            drawPlusShape(canvasObj.ctx, x, y);
        } else {
            canvasObj.ctx.fillRect(x, y, 1, 1);
        }

        // Emit erase event to the server
        socket.emit('draw-pixel', { canvasId: canvasObj.id, x, y, color: eraseColor, size: pencilSize, tool: 'eraser' });
    }
}

// Fill Tool
class FillTool extends Tool {
    constructor(name) {
        super(name);
    }

    onMouseDown(e, canvasObj) {
        if (!isAuthenticated) {
            alert('You must be logged in with Discord to use the fill tool.');
            return;
        }
        this.fill(e, canvasObj);
    }

    onMouseMove(e, canvasObj) {}
    onMouseUp(e, canvasObj) {}

    fill(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const targetColor = getPixelColor(canvasObj.id, x, y);
        if (targetColor.toLowerCase() === currentColor.toLowerCase()) return; // Avoid unnecessary fill

        // Emit fill event to the server
        socket.emit('fill', { canvasId: canvasObj.id, x, y, targetColor, newColor: currentColor });
    }
}

// Color Picker Tool
class ColorPickerTool extends Tool {
    constructor(name) {
        super(name);
    }

    onMouseDown(e, canvasObj) {
        this.pickColor(e, canvasObj);
    }

    onMouseMove(e, canvasObj) {}
    onMouseUp(e, canvasObj) {}

    pickColor(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const color = getPixelColor(canvasObj.id, x, y);
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
    'pencil': new PencilTool('pencil'),
    'eraser': new EraserTool('eraser'),
    'fill': new FillTool('fill'),
    'color-picker': new ColorPickerTool('color-picker')
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

// Initialize on Page Load
window.onload = () => {
    fetchAuthStatus();

    // Initialize the first canvas (0,0)

	socket.emit('request-canvas-list');

	socket.on('update-canvas-list', (data) => {
		const { canvasList } = data;
		canvasList.forEach(canvasId => {
			const [x, y] = canvasId.split('|').map(Number);
			createCanvasWrapper(x, y);
		});

		// if not canvas at 0,0, create it

		if (!canvasList.includes('0|0')) {
			createCanvasWrapper(0, 0);
		}
	});

    // Initialize event listeners for panning and zooming
    initPanAndZoom();
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

// Function to create a new canvas wrapper at (x, y)
function createCanvasWrapper(x, y) {
    const canvasId = `${x}|${y}`;

    if (canvases.has(canvasId)) {
        // Canvas already exists
        return;
    }

    // Create canvas wrapper
    const wrapper = document.createElement('div');
    wrapper.classList.add('canvas-wrapper');
    wrapper.setAttribute('data-x', x);
    wrapper.setAttribute('data-y', y);

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.classList.add('canvas');
    canvas.width = 512;
    canvas.height = 512;
    wrapper.appendChild(canvas);

    // Create directional arrows
    const directions = ['up', 'down', 'left', 'right'];
    directions.forEach(direction => {
        const arrow = document.createElement('button');
        arrow.classList.add('arrow', direction);
        arrow.title = `Add Canvas ${capitalize(direction)}`;
        arrow.innerHTML = `<i class="fas fa-arrow-${direction}"></i>`;
        arrow.addEventListener('click', () => {
            handleArrowClick(x, y, direction);
        });
        wrapper.appendChild(arrow);
    });

    // Append to canvas map
    canvasMap.appendChild(wrapper);

    // Get context
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Initialize canvas object
    const canvasObj = {
        id: canvasId,
        x: x,
        y: y,
        canvas: canvas,
        ctx: ctx,
        drawing: false,
        tool: tools[currentTool]
    };

    canvases.set(canvasId, canvasObj);

    // Connect to Socket.IO room
    socket.emit('join-canvas', { canvasId });

    // Listen for drawing events globally
    socket.on('draw-pixel', (data) => {
        if (data.canvasId !== canvasId) return;
        const { x: drawX, y: drawY, color, size, tool } = data;
        ctx.fillStyle = color;
        ctx.imageSmoothingEnabled = false;

        if (size >= 3) {
            drawCircle(ctx, drawX, drawY, size / 2);
        } else if (size === 2) {
            drawPlusShape(ctx, drawX, drawY);
        } else {
            ctx.fillRect(drawX, drawY, 1, 1);
        }
    });

    // Listen for fill events globally
    socket.on('fill', (data) => {
        if (data.canvasId !== canvasId) return;
        const { x: fillX, y: fillY, targetColor, newColor } = data;
        floodFill(fillX, fillY, targetColor, newColor, canvasId);
    });

    // Listen for initial canvas data
    socket.on('init-canvas', (data) => {
        if (data.canvasId === canvasId) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const canvasData = data.canvasData;
            for (let key in canvasData) {
                const [px, py] = key.split(',').map(Number);
                ctx.fillStyle = canvasData[key].color;
                ctx.fillRect(px, py, 1, 1);
            }
            // Hide loading indicator if active
            loadingIndicator.style.display = 'none';
            // Update arrows based on existing canvases
            updateArrowsVisibility(x, y);
        }
    });

    // Add mouse event listeners for drawing
    addCanvasEventListeners(canvas, canvasObj);

    // Display loading indicator while canvas is loading
    loadingIndicator.style.display = 'flex';
}

// Handle directional arrow clicks to create new canvases
function handleArrowClick(currentX, currentY, direction) {
    let newX = currentX;
    let newY = currentY;

    switch(direction) {
        case 'up':
            newY += 1;
            break;
        case 'down':
            newY -= 1;
            break;
        case 'left':
            newX -= 1;
            break;
        case 'right':
            newX += 1;
            break;
        default:
            return;
    }


    if (canvases.has(generateCanvasId(newX, newY))) {
        alert('Canvas already exists in this direction.');
        return;
    }

    // Show loading indicator
    loadingIndicator.style.display = 'flex';

    // Create the new canvas
    createCanvasWrapper(newX, newY);
}

// Utility Functions

// Capitalize first letter
function capitalize(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

// Translate mouse event to canvas coordinates
function getCanvasCoordinates(e, canvasObj) {
    const rect = canvasObj.canvas.getBoundingClientRect();
    const scaleX = canvasObj.canvas.width / rect.width;
    const scaleY = canvasObj.canvas.height / rect.height;

    const x = Math.floor((e.clientX - rect.left) * scaleX);
    const y = Math.floor((e.clientY - rect.top) * scaleY);
    return { x, y };
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

// Flood fill algorithm (client-side for visualization)
function floodFill(x, y, targetColor, newColor, canvasId) {
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;

    const stack = [];
    stack.push({ x: x, y: y });

    while (stack.length > 0) {
        const { x, y } = stack.pop();
        const key = `${x},${y}`;

        // Get current color at (x, y)
        const currentPixelColor = getPixelColor(canvasId, x, y);
        if (currentPixelColor.toLowerCase() !== targetColor.toLowerCase()) continue;
        if (currentPixelColor.toLowerCase() === newColor.toLowerCase()) continue;

        canvasObj.ctx.fillStyle = newColor;
        canvasObj.ctx.fillRect(x, y, 1, 1);

        stack.push({ x: x + 1, y: y });
        stack.push({ x: x - 1, y: y });
        stack.push({ x: x, y: y + 1 });
        stack.push({ x: x, y: y - 1 });
    }
}

// Get pixel color from canvas
function getPixelColor(canvasId, x, y) {
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return '#FFFFFF'; // Default color

    try {
        const pixelData = canvasObj.ctx.getImageData(x, y, 1, 1).data;
        const color = `#${((1 << 24) + (pixelData[0] << 16) + (pixelData[1] << 8) + pixelData[2]).toString(16).slice(1)}`;
        return color;
    } catch (error) {
        console.error('Error getting pixel color:', error);
        return '#FFFFFF';
    }
}

// Tooltip Handling
canvasMap.addEventListener('mousemove', (e) => {
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper) {
        hidePixelInfo();
        return;
    }

    const canvasId = targetCanvasWrapper.getAttribute('data-x') + '|' + targetCanvasWrapper.getAttribute('data-y');
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) {
        hidePixelInfo();
        return;
    }

    const { x, y } = getCanvasCoordinates(e, canvasObj);
    const key = `${x},${y}`;

    // Since client doesn't have authoritative canvasData, we can request server data or skip tooltip
    // Implement tooltip as needed based on your data handling strategy
});

function showPixelInfo(e, info) {
    tooltip.innerHTML = `
        <strong>Placed by:</strong> ${info.user.username}<br>
        <strong>At:</strong> ${new Date(info.timestamp).toLocaleString()}
    `;
    tooltip.style.left = `${e.pageX + 10}px`;
    tooltip.style.top = `${e.pageY + 10}px`;
    tooltip.style.display = 'block';
}

function hidePixelInfo() {
    if (tooltip) {
        tooltip.style.display = 'none';
    }
}

let disableDrawing = false; // A flag to prevent drawing during panning

function initPanAndZoom() {
    let isMouseDown = false;
    let isSpacePressed = false;
    let lastMousePosition = { x: 0, y: 0 };

    // Mouse Events for Panning with middle mouse button or space + left mouse
    document.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && isSpacePressed)) { // Middle mouse or Space + Left mouse
            e.preventDefault();
            isPanning = true;
            isMouseDown = true;
            disableDrawing = true;  // Disable drawing when panning
            lastMousePosition = { x: e.clientX, y: e.clientY };
            canvasMap.classList.add('grabbing');
        }
    });

    window.addEventListener('mouseup', () => {
        if (isPanning) {
            isPanning = false;
            isMouseDown = false;
            disableDrawing = false;  // Re-enable drawing after panning
            canvasMap.classList.remove('grabbing');
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        const deltaX = e.clientX - lastMousePosition.x;
        const deltaY = e.clientY - lastMousePosition.y;
        currentPan.x += deltaX;
        currentPan.y += deltaY;
        lastMousePosition = { x: e.clientX, y: e.clientY };

        updateCanvasMapTransform();
    });

	// Zooming with mouse wheel, applied to the entire document
	document.addEventListener('wheel', (e) => {
		e.preventDefault();
		const rect = canvasMap.getBoundingClientRect();
		const mouseX = e.clientX - rect.left;
		const mouseY = e.clientY - rect.top;

		const wheel = e.deltaY < 0 ? 1 : -1;
		const zoomFactor = 0.1;
		let newZoom = currentZoom + wheel * zoomFactor;

		// Constrain zoom level between minZoom and maxZoom
		newZoom = Math.min(Math.max(newZoom, minZoom), maxZoom);
		const zoomChange = newZoom / currentZoom;

		// Adjust pan relative to the mouse position for zoom effect
		currentPan.x -= mouseX * (zoomChange - 1);
		currentPan.y -= mouseY * (zoomChange - 1);

		currentZoom = newZoom;
		updateCanvasMapTransform();
	});

    // Panning with spacebar
    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            isSpacePressed = true;
            disableDrawing = true;  // Disable drawing while holding space
            canvasMap.classList.add('grab');
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            isSpacePressed = false;
            disableDrawing = false;  // Re-enable drawing after releasing space
            canvasMap.classList.remove('grab');
        }
    });
}

function positionCanvas(wrapper, x, y) {
    const canvasSize = 512;
    const gap = 10; // space between canvases
    wrapper.style.left = `${x * (canvasSize + gap)}px`;
    wrapper.style.top = `${-y * (canvasSize + gap)}px`; // negative because your Y axis is inverted
}

// Update Canvas Map Transform based on currentPan and currentZoom
function updateCanvasMapTransform() {
    canvasMap.style.transform = `translate(${currentPan.x}px, ${currentPan.y}px) scale(${currentZoom})`;
}

function addCanvasEventListeners(canvas, canvasObj) {
    canvas.addEventListener('mousedown', (e) => {
        if (disableDrawing || e.button !== 0) return;  // Only draw with left click (button 0) and when not panning
        const tool = tools[currentTool];
        if (tool && tool.onMouseDown) {
            tool.onMouseDown(e, canvasObj);
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (disableDrawing || e.button !== 0) return;  // Only move with left click and when not panning
        const tool = tools[currentTool];
        if (tool && tool.onMouseMove) {
            tool.onMouseMove(e, canvasObj);
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        if (disableDrawing || e.button !== 0) return;  // Only trigger mouseup with left click
        const tool = tools[currentTool];
        if (tool && tool.onMouseUp) {
            tool.onMouseUp(e, canvasObj);
        }
    });
}


// Listen for global draw-pixel and fill events
socket.on('draw-pixel', (data) => {
    const { canvasId, x, y, color, size, tool } = data;
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;

    canvasObj.ctx.fillStyle = color;
    canvasObj.ctx.imageSmoothingEnabled = false;

    if (size >= 3) {
        drawCircle(canvasObj.ctx, x, y, size / 2);
    } else if (size === 2) {
        drawPlusShape(canvasObj.ctx, x, y);
    } else {
        canvasObj.ctx.fillRect(x, y, 1, 1);
    }
});

socket.on('fill', (data) => {
    const { canvasId, x, y, targetColor, newColor } = data;
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;
    floodFill(x, y, targetColor, newColor, canvasId);
});

function updateArrowsVisibility(x, y) {
    const directions = ['up', 'down', 'left', 'right'];
    directions.forEach(direction => {
        let neighborX = x;
        let neighborY = y;
        switch (direction) {
            case 'up':
                neighborY += 1;
                break;
            case 'down':
                neighborY -= 1;
                break;
            case 'left':
                neighborX -= 1;
                break;
            case 'right':
                neighborX += 1;
                break;
        }

        const neighborId = `${neighborX}|${neighborY}`;
        const currentWrapper = document.querySelector(`.canvas-wrapper[data-x="${x}"][data-y="${y}"]`);

        if (canvases.has(neighborId)) {
            // Hide the arrow if a neighbor canvas exists in this direction
            const arrow = currentWrapper.querySelector(`.arrow.${direction}`);
            if (arrow) {
                arrow.style.display = 'none'; // Hide arrow
            }
        } else {
            // Show the arrow if no neighbor canvas exists in this direction
            const arrow = currentWrapper.querySelector(`.arrow.${direction}`);
            if (arrow) {
                arrow.style.display = 'block'; // Show arrow
            }
        }
    });
}

// Re-define createCanvasWrapper to include arrow visibility updates
function createCanvasWrapper(x, y) {
    const canvasId = `${x}|${y}`;

    if (canvases.has(canvasId)) {
        // Canvas already exists
        return;
    }

    // Create canvas wrapper
    const wrapper = document.createElement('div');
    wrapper.classList.add('canvas-wrapper');
    wrapper.setAttribute('data-x', x);
    wrapper.setAttribute('data-y', y);
	positionCanvas(wrapper, x, y); // Position the canvas

    // Create canvas
    const canvas = document.createElement('canvas');
    canvas.classList.add('canvas');
    canvas.width = 512;
    canvas.height = 512;
    wrapper.appendChild(canvas);

    // Create directional arrows
    const directions = ['up', 'down', 'left', 'right'];
    directions.forEach(direction => {
        const arrow = document.createElement('button');
        arrow.classList.add('arrow', direction);
        arrow.title = `Add Canvas ${capitalize(direction)}`;
        arrow.innerHTML = `<i class="fas fa-arrow-${direction}"></i>`;
        arrow.addEventListener('click', () => {
            handleArrowClick(x, y, direction);
        });
        wrapper.appendChild(arrow);
    });

    // Append to canvas map
    canvasMap.appendChild(wrapper);

    // Get context
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    // Initialize canvas object
    const canvasObj = {
        id: canvasId,
        x: x,
        y: y,
        canvas: canvas,
        ctx: ctx,
        drawing: false,
        tool: tools[currentTool]
    };

    canvases.set(canvasId, canvasObj);

    // Connect to Socket.IO room
    socket.emit('join-canvas', { canvasId });

    // Listen for initial canvas data
    socket.on('init-canvas', (data) => {
        if (data.canvasId === canvasId) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const canvasData = data.canvasData;
            for (let key in canvasData) {
                const [px, py] = key.split(',').map(Number);
                ctx.fillStyle = canvasData[key].color;
                ctx.fillRect(px, py, 1, 1);
            }
            // Hide loading indicator if active
            loadingIndicator.style.display = 'none';
            // Update arrows based on existing canvases
            updateArrowsVisibility(x, y);
        }
    });

    // Listen for drawing events globally
    socket.on('draw-pixel', (data) => {
        if (data.canvasId !== canvasId) return;
        const { x: drawX, y: drawY, color, size, tool } = data;
        ctx.fillStyle = color;
        ctx.imageSmoothingEnabled = false;

        if (size >= 3) {
            drawCircle(ctx, drawX, drawY, size / 2);
        } else if (size === 2) {
            drawPlusShape(ctx, drawX, drawY);
        } else {
            ctx.fillRect(drawX, drawY, 1, 1);
        }
    });

    // Listen for fill events globally
    socket.on('fill', (data) => {
        if (data.canvasId !== canvasId) return;
        const { x: fillX, y: fillY, targetColor, newColor } = data;
        floodFill(fillX, fillY, targetColor, newColor, canvasId);
    });

    // Add mouse event listeners for drawing
    addCanvasEventListeners(canvas, canvasObj);

    // Display loading indicator while canvas is loading
    loadingIndicator.style.display = 'flex';
}

// Function to handle saving canvas data if needed (not implemented here)

// Function to handle directional arrow clicks to create new canvases
function handleArrowClick(currentX, currentY, direction) {
    let newX = currentX;
    let newY = currentY;

    switch(direction) {
        case 'up':
            newY += 1;
            break;
        case 'down':
            newY -= 1;
            break;
        case 'left':
            newX -= 1;
            break;
        case 'right':
            newX += 1;
            break;
        default:
            return;
    }

    if (canvases.has(generateCanvasId(newX, newY))) {
        return;
    }

    // Show loading indicator
    loadingIndicator.style.display = 'flex';

    // Create the new canvas
    createCanvasWrapper(newX, newY);
}

// Re-define floodFill to ensure proper functionality
function floodFill(x, y, targetColor, newColor, canvasId) {
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;

    const stack = [];
    stack.push({ x: x, y: y });

    while (stack.length > 0) {
        const { x, y } = stack.pop();
        const key = `${x},${y}`;

        // Get current color at (x, y)
        const currentPixelColor = getPixelColor(canvasId, x, y);
        if (currentPixelColor.toLowerCase() !== targetColor.toLowerCase()) continue;
        if (currentPixelColor.toLowerCase() === newColor.toLowerCase()) continue;

        canvasObj.ctx.fillStyle = newColor;
        canvasObj.ctx.fillRect(x, y, 1, 1);

        stack.push({ x: x + 1, y: y });
        stack.push({ x: x - 1, y: y });
        stack.push({ x: x, y: y + 1 });
        stack.push({ x: x, y: y - 1 });
    }
}

// Function to conditionally display/hide arrows based on existing canvases
function updateArrowsVisibility(x, y) {
    const directions = ['up', 'down', 'left', 'right'];
    directions.forEach(direction => {
        let neighborX = x;
        let neighborY = y;
        switch(direction) {
            case 'up':
                neighborY += 1;
                break;
            case 'down':
                neighborY -= 1;
                break;
            case 'left':
                neighborX -= 1;
                break;
            case 'right':
                neighborX += 1;
                break;
        }
        const currentWrapper = document.querySelector(`.canvas-wrapper[data-x="${x}"][data-y="${y}"]`);
        if (canvases.has(generateCanvasId(neighborX, neighborY))) {
            currentWrapper.classList.add(`has-${direction}`);
        } else {
            currentWrapper.classList.remove(`has-${direction}`);
        }
    });
}

// Utility Functions

// Generate a unique canvas ID (based on coordinates)
function generateCanvasId(x, y) {
    return `${x}|${y}`;
}