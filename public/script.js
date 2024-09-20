// script.js

// ==================== Constants ====================
const CANVAS_SIZE = 512; // Canvas dimensions (512x512)
const GAP_SIZE = 10;     // Gap between canvases
const ZOOM_SENSITIVITY = 0.1;
const HOVER_DELAY = 200; // Tooltip hover delay in milliseconds

const TOOL_TYPES = {
    PENCIL: 'pencil',
    ERASER: 'eraser',
    COLOR_PICKER: 'color-picker'
};

const DIRECTIONS = ['up', 'down', 'left', 'right'];

// ==================== State Variables ====================
const socket = io();

const canvasMap = document.getElementById('canvas-map');
const loadingIndicator = document.getElementById('loading-indicator');
const tooltip = document.getElementById('pixel-tooltip');

let currentTool = TOOL_TYPES.PENCIL;
let currentColor = '#FFB3BA';
let pencilSize = 6;

let isAuthenticated = false;
let userInfo = null;

const canvases = new Map(); // Map<canvasId, CanvasObject>

let isPanning = false;
let startPan = { x: 0, y: 0 };
let currentPan = { x: 0, y: 0 };
let currentZoom = 1;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 20;

let isDrawing = false;
let currentCanvasObj = null;

let disableDrawing = false;

let hoverTimeout = null;
let lastHoveredPixel = null;

const keysPressed = {};
const panSpeed = 2;

// ==================== Tool Classes ====================

// Base Tool Class
class Tool {
    constructor(name) {
        this.name = name;
    }

    onMouseDown(event, canvasObj) {}
    onMouseMove(event, canvasObj) {}
    onMouseUp(event, canvasObj) {}
}

// Pencil and Eraser Tools share similar behavior
class DrawingTool extends Tool {
    constructor(name) {
        super(name);
        this.lastPosition = null;
    }

    onMouseDown(event, canvasObj) {
        if (!isAuthenticated) return;
        isDrawing = true;
        currentCanvasObj = canvasObj;
        const { x, y } = getCanvasCoordinates(event, canvasObj);
        this.lastPosition = { x, y };
        this.plotPoint(canvasObj, x, y);
    }

    onMouseMove(event, canvasObj) {
        if (isDrawing && currentCanvasObj === canvasObj) {
            this.draw(event, canvasObj);
        }
    }

    onMouseUp() {
        isDrawing = false;
        currentCanvasObj = null;
        this.lastPosition = null;
    }

    draw(event, canvasObj) {
        const { x, y } = getCanvasCoordinates(event, canvasObj);
        const color = this.name === TOOL_TYPES.ERASER ? '#FFFFFF' : currentColor;

        if (this.lastPosition && (this.lastPosition.x !== x || this.lastPosition.y !== y)) {
            this.interpolateLine(canvasObj, this.lastPosition.x, this.lastPosition.y, x, y, color);
        }

        this.lastPosition = { x, y };
    }

    plotPoint(canvasObj, x, y) {
        const color = this.name === TOOL_TYPES.ERASER ? '#FFFFFF' : currentColor;

        if (isOutOfBounds(x, y, canvasObj)) {
            handleEdgeCrossing.call(this, x, y, canvasObj, color);
            return;
        }

        const ctx = canvasObj.ctx;
        ctx.fillStyle = color;
        ctx.imageSmoothingEnabled = false;

        if (pencilSize >= 3) {
            drawCircle(ctx, x, y, pencilSize / 2, { color, user: userInfo, timestamp: Date.now() }, canvasObj.id);
        } else if (pencilSize === 2) {
            drawPlusShape(ctx, x, y, { color, user: userInfo, timestamp: Date.now() }, canvasObj.id);
        } else {
            ctx.fillRect(x, y, 1, 1);
            updateCanvasData(canvasObj, x, y, { color, user: userInfo, timestamp: Date.now() });
        }

        socket.emit('draw-pixel', {
            canvasId: canvasObj.id,
            x,
            y,
            color,
            size: pencilSize,
            tool: this.name
        });
    }

    interpolateLine(canvasObj, x1, y1, x2, y2, color) {
        const distance = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.ceil(distance);

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const interpolatedX = Math.round(x1 + t * (x2 - x1));
            const interpolatedY = Math.round(y1 + t * (y2 - y1));

            if (isOutOfBounds(interpolatedX, interpolatedY, canvasObj)) {
                this.handleEdgeCrossing(interpolatedX, interpolatedY, canvasObj, color);
                break;
            }

            this.plotPoint(canvasObj, interpolatedX, interpolatedY);
        }
    }
}

// Pencil Tool
class PencilTool extends DrawingTool {
    constructor() {
        super(TOOL_TYPES.PENCIL);
    }
}

// Eraser Tool
class EraserTool extends DrawingTool {
    constructor() {
        super(TOOL_TYPES.ERASER);
    }
}

// Color Picker Tool
class ColorPickerTool extends Tool {
    constructor() {
        super(TOOL_TYPES.COLOR_PICKER);
    }

    onMouseDown(event, canvasObj) {
        const { x, y } = getCanvasCoordinates(event, canvasObj);
        const color = getPixelColor(canvasObj.id, x, y);
        currentColor = color;
        updateColorSwatches(color);
    }
}

// ==================== Tool Initialization ====================
const tools = {
    [TOOL_TYPES.PENCIL]: new PencilTool(),
    [TOOL_TYPES.ERASER]: new EraserTool(),
    [TOOL_TYPES.COLOR_PICKER]: new ColorPickerTool()
};

// Set default tool
document.getElementById('pencil-tool').classList.add('selected');

// ==================== Utility Functions ====================

// Check if coordinates are out of canvas bounds
function isOutOfBounds(x, y, canvasObj) {
    return x < 0 || x >= canvasObj.canvas.width || y < 0 || y >= canvasObj.canvas.height;
}

// Handle edge crossing for drawing tools
function handleEdgeCrossing(x, y, canvasObj, color) {
    let adjX = x;
    let adjY = y;

    if (x < 0) adjX = canvasObj.canvas.width - 1;
    else if (x >= canvasObj.canvas.width) adjX = 0;

    if (y < 0) adjY = canvasObj.canvas.height - 1;
    else if (y >= canvasObj.canvas.height) adjY = 0;

    const direction = getDirectionFromEdge(x, y, canvasObj);
    const neighborId = getNeighborCanvasId(canvasObj.id, direction);
    const adjCanvasObj = canvases.get(neighborId);

    if (adjCanvasObj) {
        this.plotPoint(adjCanvasObj, adjX, adjY);
        currentCanvasObj = adjCanvasObj;
        this.lastPosition = { x: adjX, y: adjY };
    }
}

// Get direction based on edge crossing
function getDirectionFromEdge(x, y, canvasObj) {
    if (x < 0) return 'left';
    if (x >= canvasObj.canvas.width) return 'right';
    if (y < 0) return 'down';
    if (y >= canvasObj.canvas.height) return 'up';
}

// Generate unique canvas ID
function generateCanvasId(x, y) {
    return `${x}|${y}`;
}

// Get neighboring canvas ID based on direction
function getNeighborCanvasId(currentId, direction) {
    const [x, y] = currentId.split('|').map(Number);
    switch (direction) {
        case 'left': return `${x - 1}|${y}`;
        case 'right': return `${x + 1}|${y}`;
        case 'up': return `${x}|${y + 1}`;
        case 'down': return `${x}|${y - 1}`;
        default: return null;
    }
}

// Update canvas data with pixel information
function updateCanvasData(canvasObj, x, y, pixelInfo) {
    if (!canvasObj.canvasData) {
        canvasObj.canvasData = {};
    }
    canvasObj.canvasData[`${x},${y}`] = pixelInfo;
}

// Draw a pixelated circle
function drawCircle(ctx, x, y, radius, pixelInfo, canvasId) {
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;
    radius = Math.floor(radius);
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            if ((dx * dx + dy * dy) <= (radius * radius - radius * 0.8)) {
                ctx.fillRect(x + dx, y + dy, 1, 1);
                updateCanvasData(canvasObj, x + dx, y + dy, pixelInfo);
            }
        }
    }
}

// Draw a plus shape for pencil size 2
function drawPlusShape(ctx, x, y, pixelInfo, canvasId) {
    ctx.fillRect(x, y - 1, 1, 3); // Vertical line
    ctx.fillRect(x - 1, y, 3, 1); // Horizontal line

    const pixels = [
        `${x},${y - 1}`,
        `${x},${y}`,
        `${x - 1},${y}`,
        `${x + 1},${y}`,
        `${x},${y + 1}`
    ];

    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;

    if (!canvasObj.canvasData) {
        canvasObj.canvasData = {};
    }

    pixels.forEach(key => {
        canvasObj.canvasData[key] = pixelInfo;
    });
}

// Get pixel color from a specific canvas
function getPixelColor(canvasId, x, y) {
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return '#FFFFFF';

    try {
        const pixelData = canvasObj.ctx.getImageData(x, y, 1, 1).data;
        return `#${((1 << 24) + (pixelData[0] << 16) + (pixelData[1] << 8) + pixelData[2]).toString(16).slice(1)}`;
    } catch (error) {
        console.error('Error getting pixel color:', error);
        return '#FFFFFF';
    }
}

// Update color swatches to reflect the selected color
function updateColorSwatches(selectedColor) {
    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.classList.toggle('selected', swatch.getAttribute('data-color').toLowerCase() === selectedColor.toLowerCase());
    });
}

// Show tooltip with pixel information
function showPixelInfo(event, info) {
    tooltip.innerHTML = `
        <strong>Placed by:</strong> ${info.user.username}<br>
        <strong>At:</strong> ${new Date(info.timestamp).toLocaleString()}
    `;
    tooltip.style.left = `${event.pageX + GAP_SIZE}px`;
    tooltip.style.top = `${event.pageY + GAP_SIZE}px`;
    tooltip.style.display = 'block';
}

// Hide the tooltip
function hidePixelInfo() {
    tooltip.style.display = 'none';
    clearTimeout(hoverTimeout);
}

// Position canvas based on its coordinates
function positionCanvas(wrapper, x, y) {
    wrapper.style.left = `${x * (CANVAS_SIZE + GAP_SIZE)}px`;
    wrapper.style.top = `${-y * (CANVAS_SIZE + GAP_SIZE)}px`;
}

// Update the CSS transform for panning and zooming
function updateCanvasMapTransform() {
    canvasMap.style.transform = `translate(${currentPan.x}px, ${currentPan.y}px) scale(${currentZoom})`;
    updateVisibleCanvases();
}

// ==================== Canvas Management ====================

// Create a new canvas wrapper at (x, y)
function createCanvasWrapper(x, y, alreadyLoaded = false) {
    const canvasId = generateCanvasId(x, y);
    if (canvases.has(canvasId) && !alreadyLoaded) return;

    const wrapper = document.createElement('div');
    wrapper.classList.add('canvas-wrapper');
    wrapper.dataset.x = x;
    wrapper.dataset.y = y;
    positionCanvas(wrapper, x, y);

    const canvas = document.createElement('canvas');
    canvas.classList.add('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    wrapper.appendChild(canvas);

    // Add directional arrows
    DIRECTIONS.forEach(direction => {
        const arrow = document.createElement('button');
        arrow.classList.add('arrow', direction);
        arrow.title = `Add Canvas ${capitalize(direction)}`;
        arrow.innerHTML = `<i class="fas fa-arrow-${direction}"></i>`;
        arrow.addEventListener('click', () => handleArrowClick(x, y, direction));
        wrapper.appendChild(arrow);
    });

    canvasMap.appendChild(wrapper);

    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;

    const canvasObj = {
        id: canvasId,
        x,
        y,
        canvas,
        ctx,
        drawing: false,
        rendered: true,
        canvasData: {}
    };

    canvases.set(canvasId, canvasObj);
    socket.emit('join-canvas', { canvasId });

    // Initialize canvas with data from the server
    socket.on('init-canvas', (data) => {
        if (data.canvasId === canvasId) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const { canvasData } = data;
            Object.entries(canvasData).forEach(([key, value]) => {
                const [px, py] = key.split(',').map(Number);
                ctx.fillStyle = value.color;
                ctx.fillRect(px, py, 1, 1);
            });
            canvasObj.canvasData = { ...canvasData };
            loadingIndicator.style.display = 'none';
            updateArrowsVisibility(x, y);
        }
    });

    addCanvasEventListeners(canvas, canvasObj);
}

// Handle directional arrow clicks to add new canvases
function handleArrowClick(currentX, currentY, direction) {
    if (!isAuthenticated) return;

    let newX = currentX;
    let newY = currentY;

    switch (direction) {
        case 'up': newY += 1; break;
        case 'down': newY -= 1; break;
        case 'left': newX -= 1; break;
        case 'right': newX += 1; break;
        default: return;
    }

    const newCanvasId = generateCanvasId(newX, newY);
    if (canvases.has(newCanvasId)) {
        alert('Canvas already exists in this direction.');
        return;
    }

    loadingIndicator.style.display = 'flex';
    createCanvasWrapper(newX, newY);
}

// Update the visibility of directional arrows based on existing canvases
function updateArrowsVisibility(x, y) {
    DIRECTIONS.forEach(direction => {
        const neighborId = getNeighborCanvasId(generateCanvasId(x, y), direction);
        const wrapper = document.querySelector(`.canvas-wrapper[data-x="${x}"][data-y="${y}"]`);
        if (wrapper) {
            const arrow = wrapper.querySelector(`.arrow.${direction}`);
            arrow.style.display = canvases.has(neighborId) ? 'none' : 'block';
        }

        // Also update neighboring canvases' arrows
        const [nx, ny] = neighborId ? neighborId.split('|').map(Number) : [null, null];
        if (neighborId && canvases.has(neighborId)) {
            const neighborWrapper = document.querySelector(`.canvas-wrapper[data-x="${nx}"][data-y="${ny}"]`);
            if (neighborWrapper) {
                const oppositeDirection = getOppositeDirection(direction);
                const neighborArrow = neighborWrapper.querySelector(`.arrow.${oppositeDirection}`);
                if (neighborArrow) {
                    neighborArrow.style.display = 'none';
                }
            }
        }
    });
}

// Get opposite direction for arrow visibility updates
function getOppositeDirection(direction) {
    switch (direction) {
        case 'up': return 'down';
        case 'down': return 'up';
        case 'left': return 'right';
        case 'right': return 'left';
        default: return null;
    }
}

// Capitalize the first letter of a string
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// ==================== Event Listeners ====================

// Add event listeners to a canvas for mouse and touch interactions
function addCanvasEventListeners(canvas, canvasObj) {
    canvas.addEventListener('mousedown', (e) => handleCanvasEvent(e, 'onMouseDown', canvasObj));
    canvas.addEventListener('mousemove', (e) => handleCanvasEvent(e, 'onMouseMove', canvasObj));
    canvas.addEventListener('mouseup', (e) => handleCanvasEvent(e, 'onMouseUp', canvasObj));
    canvas.addEventListener('mouseleave', (e) => handleCanvasEvent(e, 'onMouseUp', canvasObj));

    // Touch events for mobile support
    ['touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach(eventType => {
        canvas.addEventListener(eventType, (e) => handleCanvasEvent(e, `on${capitalize(eventType.split('touch')[1])}`, canvasObj));
    });
}

// Handle canvas-specific events
function handleCanvasEvent(event, handlerName, canvasObj) {
    if (disableDrawing) return;

    const tool = tools[currentTool];
    if (tool && typeof tool[handlerName] === 'function') {
        tool[handlerName](event, canvasObj);
    }
}

// Global Mouse Event Listeners for Drawing Across Canvases
document.addEventListener('mousedown', (e) => {
    if (disableDrawing || e.button !== 0) return;
    handleGlobalMouseEvent(e, 'onMouseDown');
});

document.addEventListener('mousemove', (e) => {
    if (!isDrawing) return;
    handleGlobalMouseEvent(e, 'onMouseMove');
});

document.addEventListener('mouseup', (e) => {
    if (!isDrawing) return;
    handleGlobalMouseEvent(e, 'onMouseUp');
    isDrawing = false;
    currentCanvasObj = null;
});

// Handle `mouseenter` to simulate drawing when dragging across canvases
document.addEventListener('mouseenter', (e) => {
    if (e.buttons === 1) {
        handleGlobalMouseEvent(e, 'onMouseDown');
    }
}, true);

// Handle global mouse events
function handleGlobalMouseEvent(event, handlerName) {
    const targetCanvasWrapper = event.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper) return;

    const canvasId = generateCanvasId(
        Number(targetCanvasWrapper.dataset.x),
        Number(targetCanvasWrapper.dataset.y)
    );
    const canvasObj = canvases.get(canvasId);
    if (canvasObj && tools[currentTool][handlerName]) {
        tools[currentTool][handlerName](event, canvasObj);
    }
}

// ==================== Authentication Handling ====================

// Update Login/Logout UI based on authentication status
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

// Fetch authentication status from the server
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

// ==================== Tool Selection and Configuration ====================

// Tool Selection
document.querySelectorAll('.tool-button').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.tool-button').forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        currentTool = button.id.replace('-tool', '');
    });
});

// Color Selection
document.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', (e) => {
        updateColorSwatches(e.target.getAttribute('data-color'));
        currentColor = e.target.getAttribute('data-color');
    });
});

// Pencil Size Slider
const pencilSizeDisplay = document.getElementById('pencil-size-display');
const pencilSizeSlider = document.getElementById('pencil-size-slider');

pencilSizeSlider.addEventListener('input', (e) => {
    pencilSize = parseInt(e.target.value, 10);
    pencilSizeDisplay.textContent = pencilSize;
});

// ==================== Canvas Visibility Management ====================

// Check if a canvas is visible within the viewport
function isCanvasVisible(x, y) {
    const canvasSize = CANVAS_SIZE;
    const gap = GAP_SIZE;
    const panX = currentPan.x;
    const panY = currentPan.y;
    const zoom = currentZoom;

    let canvasX = x * (canvasSize + gap) * zoom + panX;
    let canvasY = -y * (canvasSize + gap) * zoom + panY;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const viewportWidthHalf = viewportWidth / 2;
    const viewportHeightHalf = viewportHeight / 2;

    canvasX += viewportWidthHalf;
    canvasY += viewportHeightHalf;

    const canvasWidth = canvasSize * zoom;
    const canvasHeight = canvasSize * zoom;

    return (
        canvasX + canvasWidth >= 0 &&
        canvasX <= viewportWidth &&
        canvasY + canvasHeight >= 0 &&
        canvasY <= viewportHeight
    );
}

// Update the visibility of canvases based on their position
function updateVisibleCanvases() {
    canvases.forEach((canvasObj, canvasId) => {
        const [x, y] = canvasId.split('|').map(Number);
        const wrapper = document.querySelector(`.canvas-wrapper[data-x="${x}"][data-y="${y}"]`);

        if (isCanvasVisible(x, y)) {
            if (!canvasObj.rendered) {
                wrapper.style.display = '';
                socket.emit('join-canvas', { canvasId });
                canvasObj.rendered = true;
            }
        } else {
            if (canvasObj.rendered) {
                wrapper.style.display = 'none';
                socket.emit('leave-canvas', { canvasId });
                canvasObj.rendered = false;
            }
        }
    });
}

// ==================== Socket.IO Event Handling ====================

// Request initial canvas list
socket.emit('request-canvas-list');

// Handle updated canvas list from the server
socket.on('update-canvas-list', ({ canvasList }) => {
    canvasList.forEach(canvasId => {
        const [x, y] = canvasId.split('|').map(Number);
        createCanvasWrapper(x, y);
    });

    if (!canvasList.includes('0|0')) {
        createCanvasWrapper(0, 0);
    }

    updateVisibleCanvases();
});

// Handle drawing events from other users
socket.on('draw-pixel', (data) => {
    const { canvasId, x, y, color, size, tool } = data;
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) return;

    const ctx = canvasObj.ctx;
    ctx.fillStyle = color;
    ctx.imageSmoothingEnabled = false;

    if (size >= 3) {
        drawCircle(ctx, x, y, size / 2, data.pixelInfo, canvasId);
    } else if (size === 2) {
        drawPlusShape(ctx, x, y, data.pixelInfo, canvasId);
    } else {
        ctx.fillRect(x, y, 1, 1);
        updateCanvasData(canvasObj, x, y, data.pixelInfo);
    }
});

// ==================== Tooltip Handling ====================

// Handle mouse movement over the canvas map for tooltip display
canvasMap.addEventListener('mousemove', (e) => {
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper) {
        hidePixelInfo();
        clearTimeout(hoverTimeout);
        lastHoveredPixel = null;
        return;
    }

    const canvasId = generateCanvasId(
        Number(targetCanvasWrapper.dataset.x),
        Number(targetCanvasWrapper.dataset.y)
    );
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) {
        hidePixelInfo();
        clearTimeout(hoverTimeout);
        lastHoveredPixel = null;
        return;
    }

    const { x, y } = getCanvasCoordinates(e, canvasObj);
    const key = `${x},${y}`;
    const pixelData = canvasObj.canvasData[key] || null;

    const currentHoveredPixel = { canvasId, x, y };
    if (lastHoveredPixel && isSamePixel(lastHoveredPixel, currentHoveredPixel)) {
        return;
    }

    clearTimeout(hoverTimeout);
    lastHoveredPixel = currentHoveredPixel;

    if (pixelData && pixelData.user) {
        hoverTimeout = setTimeout(() => showPixelInfo(e, pixelData), HOVER_DELAY);
    } else {
        hidePixelInfo();
    }
});

// Check if two pixels are the same
function isSamePixel(pixelA, pixelB) {
    return pixelA.canvasId === pixelB.canvasId && pixelA.x === pixelB.x && pixelA.y === pixelB.y;
}

// ==================== Pan and Zoom Initialization ====================

function initPanAndZoom() {
    let isMousePanning = false;
    let lastMousePosition = { x: 0, y: 0 };

    // Touch variables for pinch-to-zoom
    let lastTouchDistance = null;
    let lastPanPosition = null;

    // Prevent native pinch-to-zoom and other gestures
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(eventType => {
        document.addEventListener(eventType, (e) => e.preventDefault(), { passive: false });
    });

    // Prevent double-finger scroll zooming in browsers
    document.addEventListener('touchmove', (e) => {
        if (e.touches.length > 1) {
            e.preventDefault();
        }
    }, { passive: false });

    // Prevent double-tap to zoom on mobile
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });

    // Disable Ctrl + Zoom shortcuts on desktop
    window.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '0'].includes(e.key)) {
            e.preventDefault();

            if (e.key === '+' || e.key === '=') {
                zoomIn();
            } else if (e.key === '-') {
                zoomOut();
            }
        }

        if (e.code === 'Space') {
            e.preventDefault();
            isSpacePressed = true;
            disableDrawing = true;
            canvasMap.classList.add('grab');
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            isSpacePressed = false;
            disableDrawing = false;
            canvasMap.classList.remove('grab');
        }

        if (keysPressed[e.key]) {
            keysPressed[e.key] = false;
        }
    });

    // Mouse wheel + Ctrl for zooming
    document.addEventListener('wheel', (e) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
            simulatePinchZoom(zoomFactor, e.clientX, e.clientY);
        } else {
            handleMouseWheelZoom(e);
        }
    }, { passive: false });

    // Simulate pinch-to-zoom with mouse wheel
    function simulatePinchZoom(zoomFactor, mouseX, mouseY) {
        const rect = canvasMap.getBoundingClientRect();
        const midpoint = { x: mouseX - rect.left, y: mouseY - rect.top };

        let newZoom = currentZoom * zoomFactor;
        newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
        const zoomChange = newZoom / currentZoom;

        currentPan.x -= midpoint.x * (zoomChange - 1);
        currentPan.y -= midpoint.y * (zoomChange - 1);

        currentZoom = newZoom;
        updateCanvasMapTransform();
    }

    // Handle regular mouse wheel zooming
    function handleMouseWheelZoom(e) {
        e.preventDefault();
        const rect = canvasMap.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const scaleFactor = ZOOM_SENSITIVITY;
        const wheel = e.deltaY < 0 ? 1 : -1;

        let newZoom = currentZoom * (1 + wheel * scaleFactor);
        newZoom = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
        const zoomChange = newZoom / currentZoom;

        currentPan.x -= mouseX * (zoomChange - 1);
        currentPan.y -= mouseY * (zoomChange - 1);

        currentZoom = newZoom;
        updateCanvasMapTransform();
    }

    // Mouse drag for panning (Shift + Left Click)
    document.addEventListener('mousedown', (e) => {
        if (e.shiftKey && e.button === 0) {
            isMousePanning = true;
            lastMousePosition = { x: e.clientX, y: e.clientY };
            canvasMap.classList.add('grabbing');
            disableDrawing = true;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (isMousePanning) {
            const deltaX = e.clientX - lastMousePosition.x;
            const deltaY = e.clientY - lastMousePosition.y;

            currentPan.x += deltaX;
            currentPan.y += deltaY;

            lastMousePosition = { x: e.clientX, y: e.clientY };
            updateCanvasMapTransform();
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (isMousePanning && e.button === 0) {
            isMousePanning = false;
            canvasMap.classList.remove('grabbing');
            disableDrawing = false;
        }
    });

    // Touch events for pinch-to-zoom and panning
    canvasMap.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvasMap.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvasMap.addEventListener('touchend', handleTouchEnd, { passive: false });

    function handleTouchStart(e) {
        if (e.touches.length === 2) {
            e.preventDefault();
            lastTouchDistance = getTouchDistance(e.touches);
            lastPanPosition = getMidpoint(e.touches);
        }
    }

    function handleTouchMove(e) {
        if (e.touches.length === 2) {
            e.preventDefault();

            const currentDistance = getTouchDistance(e.touches);
            const midpoint = getMidpoint(e.touches);

            if (lastTouchDistance !== null) {
                const distanceDelta = currentDistance - lastTouchDistance;
                if (Math.abs(distanceDelta) > 5) {
                    const zoomFactor = 1 + (distanceDelta / currentDistance) * ZOOM_SENSITIVITY;
                    let newZoom = currentZoom * zoomFactor;
                    newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
                    const zoomChange = newZoom / currentZoom;

                    currentPan.x -= midpoint.x * (zoomChange - 1);
                    currentPan.y -= midpoint.y * (zoomChange - 1);

                    currentZoom = newZoom;
                }
            }

            lastTouchDistance = currentDistance;

            if (lastPanPosition) {
                const deltaX = midpoint.x - lastPanPosition.x;
                const deltaY = midpoint.y - lastPanPosition.y;
                currentPan.x += deltaX;
                currentPan.y += deltaY;
            }

            lastPanPosition = midpoint;
            updateCanvasMapTransform();
        }
    }

    function handleTouchEnd(e) {
        if (e.touches.length < 2) {
            lastTouchDistance = null;
            lastPanPosition = null;
        }
    }

    // Add WASD and Arrow Key Panning
    document.addEventListener('keydown', (e) => {
        if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            keysPressed[e.key] = true;
        }
    });

    document.addEventListener('keyup', (e) => {
        if (keysPressed[e.key]) {
            keysPressed[e.key] = false;
        }
    });

    // Smooth panning based on keys pressed
    function smoothPan() {
        if (keysPressed['w'] || keysPressed['ArrowUp']) {
            currentPan.y += panSpeed;
        }
        if (keysPressed['s'] || keysPressed['ArrowDown']) {
            currentPan.y -= panSpeed;
        }
        if (keysPressed['a'] || keysPressed['ArrowLeft']) {
            currentPan.x += panSpeed;
        }
        if (keysPressed['d'] || keysPressed['ArrowRight']) {
            currentPan.x -= panSpeed;
        }

        if (Object.values(keysPressed).includes(true)) {
            updateCanvasMapTransform();
        }

        requestAnimationFrame(smoothPan);
    }
    smoothPan();
}

// Calculate distance between two touch points
function getTouchDistance(touches) {
    const [touch1, touch2] = touches;
    const dx = touch1.clientX - touch2.clientX;
    const dy = touch1.clientY - touch2.clientY;
    return Math.hypot(dx, dy);
}

// Calculate midpoint between two touch points
function getMidpoint(touches) {
    const [touch1, touch2] = touches;
    return {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2
    };
}

// Zoom in by a fixed factor
function zoomIn() {
    const zoomFactor = 0.2;
    let newZoom = currentZoom + zoomFactor;
    if (newZoom > MAX_ZOOM) return;

    const zoomChange = newZoom / currentZoom;
    currentPan.x *= zoomChange;
    currentPan.y *= zoomChange;

    currentZoom = newZoom;
    updateCanvasMapTransform();
}

// Zoom out by a fixed factor
function zoomOut() {
    const zoomFactor = 0.2;
    let newZoom = currentZoom - zoomFactor;
    if (newZoom < MIN_ZOOM) return;

    const zoomChange = newZoom / currentZoom;
    currentPan.x *= zoomChange;
    currentPan.y *= zoomChange;

    currentZoom = newZoom;
    updateCanvasMapTransform();
}

// ==================== Initialization ====================

window.onload = () => {
    fetchAuthStatus();
    socket.emit('request-canvas-list');
    initPanAndZoom();

    // Prevent double-tap to zoom on mobile
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
};

// ==================== Canvas Visibility Update on Resize ====================

window.addEventListener('resize', updateVisibleCanvases);

// ==================== Helper Functions ====================

// Get canvas coordinates from mouse or touch event
function getCanvasCoordinates(event, canvasObj) {
    const rect = canvasObj.canvas.getBoundingClientRect();
    const scaleX = canvasObj.canvas.width / rect.width;
    const scaleY = canvasObj.canvas.height / rect.height;

    if (event.touches && event.touches.length > 0) {
        const x = Math.floor((event.touches[0].clientX - rect.left) * scaleX);
        const y = Math.floor((event.touches[0].clientY - rect.top) * scaleY);
        return { x, y };
    } else {
        const x = Math.floor((event.clientX - rect.left) * scaleX);
        const y = Math.floor((event.clientY - rect.top) * scaleY);
        return { x, y };
    }
}
