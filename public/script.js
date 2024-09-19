// script.js

// Initialize Socket.IO
const socket = io();

// Canvas Map Setup
const canvasMap = document.getElementById('canvas-map');
const loadingIndicator = document.getElementById('loading-indicator');

// Tool Setup
let currentTool = 'pencil';
let currentColor = '#FFB3BA'; // Default color
let pencilSize = 6;

// Authentication state
let isAuthenticated = false;
let userInfo = null;

// Map to track existing canvases and their contexts
const canvases = new Map(); // key: 'x|y', value: { canvas, ctx, drawing }

// Panning and Zooming variables
let isPanning = false;
let startPan = { x: 0, y: 0 };
let currentPan = { x: 0, y: 0 };
let currentZoom = 1;
const minZoom = 0.2;
const maxZoom = 20;

// Tooltip Element
const tooltip = document.getElementById('pixel-tooltip');

// Track drawing state globally
let isDrawing = false;
let currentCanvasObj = null;

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
        this.lastPosition = null; // Store the last mouse position
    }

    onMouseDown(e, canvasObj) {
        if (!isAuthenticated) {
            return;
        }
        isDrawing = true;
        currentCanvasObj = canvasObj;
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        this.lastPosition = { x, y }; // Store the start position
        this.plotPoint(canvasObj, x, y, currentColor); // Plot the initial point on mouse down
    }

    onMouseMove(e, canvasObj) {
        if (isDrawing && currentCanvasObj) {
            this.draw(e, currentCanvasObj);
        }
    }

    onMouseUp(e, canvasObj) {
        isDrawing = false;
        currentCanvasObj = null;
        this.lastPosition = null; // Reset last position when drawing ends
    }

    draw(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const drawColor = currentTool === 'eraser' ? '#FFFFFF' : currentColor;

        if (this.lastPosition && (this.lastPosition.x !== x || this.lastPosition.y !== y)) {
            this.interpolateLine(canvasObj, this.lastPosition.x, this.lastPosition.y, x, y, drawColor);
        }

        this.lastPosition = { x, y };
    }

    plotPoint(canvasObj, x, y, drawColor) {
        if (x < 0 || x >= canvasObj.canvas.width || y < 0 || y >= canvasObj.canvas.height) {
            let adjCanvasObj = null;
            let adjX = x;
            let adjY = y;

            // Determine direction and correct edge crossing logic
            if (x < 0) {
                adjX = canvasObj.canvas.width - 1;
            } else if (x >= canvasObj.canvas.width) {
                adjX = 0;
            } else if (y < 0) {
                adjY = canvasObj.canvas.height - 1;
            } else if (y >= canvasObj.canvas.height) {
                adjY = 0;
            }

            const direction = this.getDirectionFromEdge(x, y, canvasObj);
            const neighborId = getNeighborCanvasId(canvasObj.id, direction);

            adjCanvasObj = canvases.get(neighborId);
            if (adjCanvasObj) {
                this.plotPoint(adjCanvasObj, adjX, adjY, drawColor);
                this.lastPosition = { x: adjX, y: adjY };
                currentCanvasObj = adjCanvasObj;
            }
            return;
        }

        // Plot normally within the current canvas
        canvasObj.ctx.fillStyle = drawColor;
        canvasObj.ctx.imageSmoothingEnabled = false;

        if (pencilSize >= 3) {
            drawCircle(canvasObj.ctx, x, y, pencilSize / 2, { color: drawColor, user: userInfo, timestamp: Date.now() }, canvasObj.id);
        } else if (pencilSize === 2) {
            drawPlusShape(canvasObj.ctx, x, y, { color: drawColor, user: userInfo, timestamp: Date.now() }, canvasObj.id);
        } else {
            canvasObj.ctx.fillRect(x, y, 1, 1);
        }

		// update local pixel data
		if (!canvasObj.canvasData) {
			canvasObj.canvasData = {};
		}
		canvasObj.canvasData[`${x},${y}`] = { color: drawColor, user: userInfo, timestamp: Date.now() };

        socket.emit('draw-pixel', { canvasId: canvasObj.id, x, y, color: drawColor, size: pencilSize, tool: currentTool });
    }

    interpolateLine(canvasObj, x1, y1, x2, y2, drawColor) {
        const distance = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.ceil(distance);

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            let interpolatedX = Math.round(x1 + t * (x2 - x1));
            let interpolatedY = Math.round(y1 + t * (y2 - y1));

            // Stop interpolation at the edges and handle edge crossing
            if (interpolatedX < 0 || interpolatedX >= canvasObj.canvas.width || interpolatedY < 0 || interpolatedY >= canvasObj.canvas.height) {
                this.handleEdgeCrossing(interpolatedX, interpolatedY, canvasObj, drawColor);
                break;  // Stop interpolation and handle crossing to the next canvas
            }

            this.plotPoint(canvasObj, interpolatedX, interpolatedY, drawColor);
        }
    }

    handleEdgeCrossing(x, y, canvasObj, drawColor) {
        let adjX = x;
        let adjY = y;

        if (x < 0) adjX = canvasObj.canvas.width - 1;
        else if (x >= canvasObj.canvas.width) adjX = 0;

        if (y < 0) adjY = canvasObj.canvas.height - 1;
        else if (y >= canvasObj.canvas.height) adjY = 0;

        const direction = this.getDirectionFromEdge(x, y, canvasObj);
        const neighborId = getNeighborCanvasId(canvasObj.id, direction);
        const adjCanvasObj = canvases.get(neighborId);

        if (adjCanvasObj) {
            this.plotPoint(adjCanvasObj, adjX, adjY, drawColor);
            currentCanvasObj = adjCanvasObj;  // Update current canvas after crossing
            this.lastPosition = { x: adjX, y: adjY };
        }
    }

    getDirectionFromEdge(x, y, canvasObj) {
        if (x < 0) return 'left';
        if (x >= canvasObj.canvas.width) return 'right';
        if (y < 0) return 'down';
        if (y >= canvasObj.canvas.height) return 'up';
    }
}


// Eraser Tool
class EraserTool extends Tool {
    constructor(name) {
        super(name);
        this.lastPosition = null; // Store the last mouse position
    }

    onMouseDown(e, canvasObj) {
        if (!isAuthenticated) {
            return;
        }
        isDrawing = true;
        currentCanvasObj = canvasObj;
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        this.lastPosition = { x, y }; // Store the start position
        this.plotPoint(canvasObj, x, y, '#FFFFFF'); // Erase the initial point on mouse down
    }

    onMouseMove(e, canvasObj) {
        if (isDrawing && currentCanvasObj) {
            this.erase(e, currentCanvasObj);
        }
    }

    onMouseUp(e, canvasObj) {
        isDrawing = false;
        currentCanvasObj = null;
        this.lastPosition = null; // Reset last position when erasing ends
    }

    erase(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const eraseColor = '#FFFFFF';

        if (this.lastPosition && (this.lastPosition.x !== x || this.lastPosition.y !== y)) {
            this.interpolateLine(canvasObj, this.lastPosition.x, this.lastPosition.y, x, y, eraseColor);
        }

        this.lastPosition = { x, y };
    }

    plotPoint(canvasObj, x, y, drawColor) {
        if (x < 0 || x >= canvasObj.canvas.width || y < 0 || y >= canvasObj.canvas.height) {
            let adjCanvasObj = null;
            let adjX = x;
            let adjY = y;

            // Determine direction and correct edge crossing logic
            if (x < 0) {
                adjX = canvasObj.canvas.width - 1;
            } else if (x >= canvasObj.canvas.width) {
                adjX = 0;
            } else if (y < 0) {
                adjY = canvasObj.canvas.height - 1;
            } else if (y >= canvasObj.canvas.height) {
                adjY = 0;
            }

            const direction = this.getDirectionFromEdge(x, y, canvasObj);
            const neighborId = getNeighborCanvasId(canvasObj.id, direction);

            adjCanvasObj = canvases.get(neighborId);
            if (adjCanvasObj) {
                this.plotPoint(adjCanvasObj, adjX, adjY, drawColor);
                this.lastPosition = { x: adjX, y: adjY };
                currentCanvasObj = adjCanvasObj;
            }
            return;
        }

        // Plot normally within the current canvas
        canvasObj.ctx.fillStyle = drawColor;
        canvasObj.ctx.imageSmoothingEnabled = false;

        if (pencilSize >= 3) {
            drawCircle(canvasObj.ctx, x, y, pencilSize / 2, { color: drawColor, user: userInfo, timestamp: Date.now() }, canvasObj.id);
        } else if (pencilSize === 2) {
            drawPlusShape(canvasObj.ctx, x, y, { color: drawColor, user: userInfo, timestamp: Date.now() }, canvasObj.id);
        } else {
            canvasObj.ctx.fillRect(x, y, 1, 1);
        }

		if (!canvasObj.canvasData) {
			canvasObj.canvasData = {};
		}
		canvasObj.canvasData[`${x},${y}`] = { color: drawColor, user: userInfo, timestamp: Date.now() };

        socket.emit('draw-pixel', { canvasId: canvasObj.id, x, y, color: drawColor, size: pencilSize, tool: currentTool });
    }

    interpolateLine(canvasObj, x1, y1, x2, y2, drawColor) {
        const distance = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.ceil(distance);

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            let interpolatedX = Math.round(x1 + t * (x2 - x1));
            let interpolatedY = Math.round(y1 + t * (y2 - y1));

            // Stop interpolation at the edges and handle edge crossing
            if (interpolatedX < 0 || interpolatedX >= canvasObj.canvas.width || interpolatedY < 0 || interpolatedY >= canvasObj.canvas.height) {
                this.handleEdgeCrossing(interpolatedX, interpolatedY, canvasObj, drawColor);
                break;  // Stop interpolation and handle crossing to the next canvas
            }

            this.plotPoint(canvasObj, interpolatedX, interpolatedY, drawColor);
        }
    }

    handleEdgeCrossing(x, y, canvasObj, drawColor) {
        let adjX = x;
        let adjY = y;

        if (x < 0) adjX = canvasObj.canvas.width - 1;
        else if (x >= canvasObj.canvas.width) adjX = 0;

        if (y < 0) adjY = canvasObj.canvas.height - 1;
        else if (y >= canvasObj.canvas.height) adjY = 0;

        const direction = this.getDirectionFromEdge(x, y, canvasObj);
        const neighborId = getNeighborCanvasId(canvasObj.id, direction);
        const adjCanvasObj = canvases.get(neighborId);

        if (adjCanvasObj) {
            this.plotPoint(adjCanvasObj, adjX, adjY, drawColor);
            currentCanvasObj = adjCanvasObj;  // Update current canvas after crossing
            this.lastPosition = { x: adjX, y: adjY };
        }
    }

    getDirectionFromEdge(x, y, canvasObj) {
        if (x < 0) return 'left';
        if (x >= canvasObj.canvas.width) return 'right';
        if (y < 0) return 'down';
        if (y >= canvasObj.canvas.height) return 'up';
    }
}

const color = currentColor;
currentColor = color;

const swatches = document.querySelectorAll('.color-swatch');
swatches.forEach(swatch => {
	swatch.classList.remove('selected');
	if (swatch.getAttribute('data-color').toLowerCase() === color.toLowerCase()) {
		swatch.classList.add('selected');
	}
});

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
    'color-picker': new ColorPickerTool('color-picker')
};

// Set default tool
currentTool = 'pencil';
document.getElementById('pencil-tool').classList.add('selected');

// Global Mouse Event Listeners for Drawing Across Canvases
// Global Mouse Event Listeners for Drawing Across Canvases
document.addEventListener('mousedown', (e) => {
    if (disableDrawing || e.button !== 0) return;  // Only draw with left click (button 0)
    handleMouseDown(e);
});

document.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;  // Only draw if drawing state is active
    handleMouseMove(e);
});

document.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    handleMouseUp(e);
    isDrawing = false;
    currentCanvasObj = null;
});

// Handle `mouseenter` to simulate drawing when dragging across canvases
document.addEventListener('mouseenter', (e) => {
    if (e.buttons === 1) {  // If the left mouse button is being held down
        handleMouseDown(e);  // Simulate `mousedown` when dragging into a new canvas
    }
}, true);

// Function to handle mouse down
function handleMouseDown(e) {
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper) return;

    const canvasId = targetCanvasWrapper.getAttribute('data-x') + '|' + targetCanvasWrapper.getAttribute('data-y');
    const canvasObj = canvases.get(canvasId);

    if (canvasObj) {
        const tool = tools[currentTool];
        if (tool && tool.onMouseDown) {
            tool.onMouseDown(e, canvasObj);
        }
    }
}

// Function to handle mouse move
function handleMouseMove(e) {
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper || !currentCanvasObj) return;

    const canvasId = targetCanvasWrapper.getAttribute('data-x') + '|' + targetCanvasWrapper.getAttribute('data-y');
    const canvasObj = canvases.get(canvasId);

    if (canvasObj && tools[currentTool].onMouseMove) {
        tools[currentTool].onMouseMove(e, canvasObj);
    }
}

// Function to handle mouse up
function handleMouseUp(e) {
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper || !currentCanvasObj) return;

    const canvasId = targetCanvasWrapper.getAttribute('data-x') + '|' + targetCanvasWrapper.getAttribute('data-y');
    const canvasObj = canvases.get(canvasId);

    if (canvasObj && tools[currentTool].onMouseUp) {
        tools[currentTool].onMouseUp(e, canvasObj);
    }
}

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

    socket.emit('request-canvas-list');

    socket.on('update-canvas-list', (data) => {
        const { canvasList } = data;
        canvasList.forEach(canvasId => {
            const [x, y] = canvasId.split('|').map(Number);
            createCanvasWrapper(x, y);
        });

        if (!canvasList.includes('0|0')) {
            createCanvasWrapper(0, 0);
        }
    });

    initPanAndZoom();
};

// Event Listeners for Tool Selection
document.querySelectorAll('.tool-button').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.tool-button').forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
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
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.classList.add('canvas-wrapper');
    wrapper.setAttribute('data-x', x);
    wrapper.setAttribute('data-y', y);
    positionCanvas(wrapper, x, y);

    const canvas = document.createElement('canvas');
    canvas.classList.add('canvas');
    canvas.width = 512;
    canvas.height = 512;
    wrapper.appendChild(canvas);

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

    canvasMap.appendChild(wrapper);

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

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

    socket.emit('join-canvas', { canvasId });

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
			canvasObj.canvasData = canvasData;
            loadingIndicator.style.display = 'none';
            updateArrowsVisibility(x, y);
        }
    });

    addCanvasEventListeners(canvas, canvasObj);
}

function handleArrowClick(currentX, currentY, direction) {
    let newX = currentX;
    let newY = currentY;

	// if not authenticated, do not allow creating new canvases
	if (!isAuthenticated) {
		return
	}

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

    const newCanvasId = generateCanvasId(newX, newY);
    if (canvases.has(newCanvasId)) {
        alert('Canvas already exists in this direction.');
        return;
    }

    loadingIndicator.style.display = 'flex';
    createCanvasWrapper(newX, newY);
}

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
function drawCircle(ctx, x, y, radius, pixelinfo, canvasId) {
	const canvasObj = canvases.get(canvasId);
	if (!canvasObj) return;
    radius = Math.floor(radius);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if ((dx * dx + dy * dy) <= (radius * radius - radius * 0.2)) {
                ctx.fillRect(x + dx, y + dy, 1, 1);
				const key = `${x + dx},${y + dy}`;
				canvasObj.canvasData[key] = pixelinfo;
            }
        }
    }
}

// Draw a plus shape for size 2
function drawPlusShape(ctx, x, y, pixelinfo, canvasId) {
    ctx.fillRect(x, y - 1, 1, 3); // Vertical line
    ctx.fillRect(x - 1, y, 3, 1); // Horizontal line

	// add pixel data for each pixel in the plus shape
	const canvasObj = canvases.get(canvasId);
	if (!canvasObj) return;
	const key1 = `${x},${y - 1}`;
	const key2 = `${x},${y}`;
	const key3 = `${x - 1},${y}`;
	const key4 = `${x + 1},${y}`;
	const key5 = `${x},${y + 1}`;
	canvasObj.canvasData[key1] = pixelinfo;
	canvasObj.canvasData[key2] = pixelinfo;
	canvasObj.canvasData[key3] = pixelinfo;
	canvasObj.canvasData[key4] = pixelinfo;
	canvasObj.canvasData[key5] = pixelinfo;
}

// Get pixel color from canvas
function getPixelColor(canvasId, x, y) {
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return '#FFFFFF';

    try {
        const pixelData = canvasObj.ctx.getImageData(x, y, 1, 1).data;
        const color = `#${((1 << 24) + (pixelData[0] << 16) + (pixelData[1] << 8) + pixelData[2]).toString(16).slice(1)}`;
        return color;
    } catch (error) {
        console.error('Error getting pixel color:', error);
        return '#FFFFFF';
    }
}

// Variable to store the timeout ID for hover delay
let hoverTimeout = null;
let lastHoveredPixel = null; // To track if the mouse is still over the same pixel

canvasMap.addEventListener('mousemove', (e) => {
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper) {
        hidePixelInfo();
        clearTimeout(hoverTimeout); // Clear the timeout if the mouse leaves
        lastHoveredPixel = null; // Reset hovered pixel
        return;
    }

    const canvasId = targetCanvasWrapper.getAttribute('data-x') + '|' + targetCanvasWrapper.getAttribute('data-y');
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) {
        hidePixelInfo();
        clearTimeout(hoverTimeout); // Clear the timeout if the mouse leaves
        lastHoveredPixel = null; // Reset hovered pixel
        return;
    }

    const { x, y } = getCanvasCoordinates(e, canvasObj);
    const key = `${x},${y}`;
    
    // Fetch the pixel data for the hovered pixel
    const pixelData = canvasObj.canvasData ? canvasObj.canvasData[key] : null;

    // Check if hovering over a new pixel or same pixel
    const currentHoveredPixel = { canvasId, x, y };
    if (lastHoveredPixel && lastHoveredPixel.canvasId === canvasId && lastHoveredPixel.x === x && lastHoveredPixel.y === y) {
        // Still hovering over the same pixel, do nothing
        return;
    }

    // Clear any previous timeout when moving to a new pixel
    clearTimeout(hoverTimeout);
    lastHoveredPixel = currentHoveredPixel; // Update the last hovered pixel

    if (pixelData && pixelData.user) {
        // Set a timeout to show the tooltip after 5 seconds
        /*hoverTimeout = setTimeout(() => {
            showPixelInfo(e, pixelData);
        }, 200);*/
		showPixelInfo(e, pixelData);
    } else {
        hidePixelInfo();
    }
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
    tooltip.style.display = 'none';
    clearTimeout(hoverTimeout); // Clear the timeout when hiding the tooltip
}

let disableDrawing = false;

function initPanAndZoom() {
    let isMouseDown = false;
    let isSpacePressed = false;
    let lastMousePosition = { x: 0, y: 0 };

    document.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && isSpacePressed)) {
            e.preventDefault();
            isPanning = true;
            isMouseDown = true;
            disableDrawing = true;
            lastMousePosition = { x: e.clientX, y: e.clientY };
            canvasMap.classList.add('grabbing');
        }
    });

    window.addEventListener('mouseup', () => {
        if (isPanning) {
            isPanning = false;
            isMouseDown = false;
            disableDrawing = false;
            canvasMap.classList.remove('grabbing');
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;

        const deltaX = e.clientX - lastMousePosition.x;
        const deltaY = e.clientY - lastMousePosition.y;

        if (deltaX !== 0 || deltaY !== 0) {
            currentPan.x += deltaX;
            currentPan.y += deltaY;

            lastMousePosition = { x: e.clientX, y: e.clientY };

            updateCanvasMapTransform();
        }
    });

	document.addEventListener('wheel', (e) => {
		e.preventDefault();
		const rect = canvasMap.getBoundingClientRect();
		const mouseX = e.clientX - rect.left;
		const mouseY = e.clientY - rect.top;
	
		const scaleFactor = 0.1; // Control zoom speed here
		const wheel = e.deltaY < 0 ? 1 : -1;
		
		// Apply exponential scaling for smoother zoom
		let newZoom = currentZoom * (1 + wheel * scaleFactor);
	
		// Keep zoom within bounds
		newZoom = Math.min(Math.max(newZoom, minZoom), maxZoom);
		const zoomChange = newZoom / currentZoom;
	
		// Adjust panning to keep the mouse position in the same place
		currentPan.x -= mouseX * (zoomChange - 1);
		currentPan.y -= mouseY * (zoomChange - 1);
	
		currentZoom = newZoom;
		updateCanvasMapTransform();
	});
	

    document.addEventListener('keydown', (e) => {
        if (e.code === 'Space') {
            e.preventDefault();
            isSpacePressed = true;
            disableDrawing = true;
            canvasMap.classList.add('grab');
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            isSpacePressed = false;
            disableDrawing = false;
            canvasMap.classList.remove('grab');
        }
    });
}

function positionCanvas(wrapper, x, y) {
    const canvasSize = 512;
    const gap = 10;
    wrapper.style.left = `${x * (canvasSize + gap)}px`;
    wrapper.style.top = `${-y * (canvasSize + gap)}px`;
}

function updateCanvasMapTransform() {
    canvasMap.style.transform = `translate(${currentPan.x}px, ${currentPan.y}px) scale(${currentZoom})`;
}

function addCanvasEventListeners(canvas, canvasObj) {
    canvas.addEventListener('mousedown', (e) => {
        if (disableDrawing || e.button !== 0) return;
        const tool = tools[currentTool];
        if (tool && tool.onMouseDown) {
            tool.onMouseDown(e, canvasObj);
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (disableDrawing || e.buttons !== 1) return;
        const tool = tools[currentTool];
        if (tool && tool.onMouseMove) {
            tool.onMouseMove(e, canvasObj);
        }
    });

    canvas.addEventListener('mouseup', (e) => {
        if (disableDrawing || e.button !== 0) return;
        const tool = tools[currentTool];
        if (tool && tool.onMouseUp) {
            tool.onMouseUp(e, canvasObj);
        }
    });

    canvas.addEventListener('mouseleave', (e) => {
        if (disableDrawing) return;
        const tool = tools[currentTool];
        if (tool && tool.onMouseUp) {
            tool.onMouseUp(e, canvasObj);
        }
    });
}

socket.on('draw-pixel', (data) => {
    const { canvasId, x, y, color, size, tool } = data;
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;

    canvasObj.ctx.fillStyle = color;
    canvasObj.ctx.imageSmoothingEnabled = false;

    if (size >= 3) {
        drawCircle(canvasObj.ctx, x, y, size / 2, data.pixelInfo, canvasId);
    } else if (size === 2) {
        drawPlusShape(canvasObj.ctx, x, y, data.pixelInfo, canvasId);
    } else {
        canvasObj.ctx.fillRect(x, y, 1, 1);
    }

	var key = `${x},${y}`;
	canvasObj.canvasData[key] = data.pixelInfo;
});

function updateArrowsVisibility(x, y) {
    const directions = ['up', 'down', 'left', 'right'];
    const updateArrowForCell = (x, y) => {
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
            if (currentWrapper) {
                const arrow = currentWrapper.querySelector(`.arrow.${direction}`);
                if (canvases.has(generateCanvasId(neighborX, neighborY))) {
                    if (arrow) {
                        arrow.style.display = 'none';
                    }
                } else {
                    if (arrow) {
                        arrow.style.display = 'block';
                    }
                }
            }
        });
    };

    // Update the arrows for the current cell
    updateArrowForCell(x, y);

    // Update the arrows for the neighboring cells
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
        updateArrowForCell(neighborX, neighborY);
    });
}


function generateCanvasId(x, y) {
    return `${x}|${y}`;
}

function getNeighborCanvasId(currentId, direction) {
    const [x, y] = currentId.split('|').map(Number);
    switch(direction) {
        case 'left': return `${x - 1}|${y}`;
        case 'right': return `${x + 1}|${y}`;
        case 'up': return `${x}|${y + 1}`;
        case 'down': return `${x}|${y - 1}`;
        default: return null;
    }
}
