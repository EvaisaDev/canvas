// script.js

// Initialize Socket.IO
const socket = io();

// Constants
const CANVAS_SIZE = 512; // 512x512 canvases
const GAP_SIZE = 10; // Gap between canvases
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 20;
const ZOOM_SENSITIVITY = 0.005;
const PAN_SPEED = 2;

// DOM Elements
const canvasMap = document.getElementById('canvas-map');
const loadingIndicator = document.getElementById('loading-indicator');
const tooltip = document.getElementById('pixel-tooltip');
const loginButton = document.getElementById('login-button');
const logoutButton = document.getElementById('logout-button');
const userInfoSpan = document.getElementById('user-info');
const pencilSizeDisplay = document.getElementById('pencil-size-display');
const pencilSizeSlider = document.getElementById('pencil-size-slider');
const toolButtons = document.querySelectorAll('.tool-button');
const colorSwatches = document.querySelectorAll('.color-swatch');

// State Variables
let currentTool = 'pencil';
let currentColor = '#FFB3BA'; // Default color
let pencilSize = 6;
let isAuthenticated = false;
let userInfo = null;
let isDrawing = false;
let currentCanvasObj = null;
let isPanning = false;
let startPan = { x: 0, y: 0 };
let currentPan = { x: 0, y: 0 };
let currentZoom = 1;
let hoverTimeout = null;
let lastHoveredPixel = null;
let disableDrawing = false;
const canvases = new Map(); // key: 'x|y', value: { canvas, ctx, canvasData, rendered }

// Tool Classes

// Base Tool Class
class Tool {
    constructor(name) {
        this.name = name;
    }

    onMouseDown(e, canvasObj) {}
    onMouseMove(e, canvasObj) {}
    onMouseUp(e, canvasObj) {}
}

// Drawing Tool (Handles Pencil and Eraser)
class DrawingTool extends Tool {
    constructor(name, isEraser = false, extra_data = {}) {
        super(name);
        this.isEraser = isEraser;
        this.lastPosition = null;
		this.extra_data = {
			targetColor: null
		};
    }

	

    onMouseDown(e, canvasObj) {
        if (!isAuthenticated) return;
        isDrawing = true;
        currentCanvasObj = canvasObj;
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        this.lastPosition = { x, y };
        const drawColor = this.isEraser ? '#FFFFFF' : currentColor;
        this.plotPoint(canvasObj, x, y, drawColor);
    }

    onMouseMove(e, canvasObj) {
        if (isDrawing && currentCanvasObj) {
            this.draw(e, currentCanvasObj);
        }
    }

    onMouseUp() {
        isDrawing = false;
        currentCanvasObj = null;
        this.lastPosition = null;
    }

    draw(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const drawColor = this.isEraser ? '#FFFFFF' : currentColor;

        if (this.lastPosition && (this.lastPosition.x !== x || this.lastPosition.y !== y)) {
            this.interpolateLine(canvasObj, this.lastPosition.x, this.lastPosition.y, x, y, drawColor);
        }

        this.lastPosition = { x, y };
    }

    plotPoint(canvasObj, x, y, drawColor) {
        // Plot within current canvas
        const adjustedColor = this.isEraser ? '#FFFFFF' : drawColor;
        drawPixel(canvasObj, x, y, adjustedColor, this.extra_data.targetColor, userInfo);

        // Emit draw event
        socket.emit('draw', {
            canvasId: canvasObj.id,
            x,
            y,
            color: adjustedColor,
            size: pencilSize,
            tool: this.name,
			extra_data: this.extra_data,
            user: userInfo,
            timestamp: Date.now()
        });
    }

    interpolateLine(canvasObj, x1, y1, x2, y2, drawColor) {
        const distance = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.ceil(distance);

        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            let interpolatedX = Math.round(x1 + t * (x2 - x1));
            let interpolatedY = Math.round(y1 + t * (y2 - y1));

			this.plotPoint(canvasObj, interpolatedX, interpolatedY, drawColor);
        }
    }
}

class MarkerTool extends DrawingTool {
	constructor(name, isEraser = false, extra_data = {}) {
		super(name, isEraser, extra_data);
	}

	onMouseDown(e, canvasObj) {
        if (!isAuthenticated) return;
        isDrawing = true;
        currentCanvasObj = canvasObj;
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        this.lastPosition = { x, y };



		const targetColor = getPixelColor(canvasObj.ctx, x, y);
		this.extra_data.targetColor = targetColor;
        const drawColor = this.isEraser ? '#FFFFFF' : currentColor;
        this.plotPoint(canvasObj, x, y, drawColor);
	}
}

// Color Picker Tool
class ColorPickerTool extends Tool {
    constructor(name) {
        super(name);
    }

    onMouseDown(e, canvasObj) {
        const { x, y } = getCanvasCoordinates(e, canvasObj);
        const color = getPixelColor(canvasObj.ctx, x, y);
        currentColor = color;
        updateColorSwatches(color);
    }
}

// Initialize Tools
const tools = {
    'pencil': new DrawingTool('pencil'),
	'highlighter': new MarkerTool('highlighter'),
    'eraser': new DrawingTool('eraser', true),
    'color-picker': new ColorPickerTool('color-picker')
};

// Set default tool
currentTool = 'pencil';
document.getElementById('pencil-tool').classList.add('selected');

// Utility Functions

/**
 * Translates mouse or touch event to canvas coordinates.
 * @param {MouseEvent | TouchEvent} e - The event object.
 * @param {object} canvasObj - The canvas object.
 * @returns {object} - An object containing x and y coordinates.
 */
function getCanvasCoordinates(e, canvasObj) {
    const rect = canvasObj.canvas.getBoundingClientRect();
    const scaleX = canvasObj.canvas.width / rect.width;
    const scaleY = canvasObj.canvas.height / rect.height;

    if (e.touches && e.touches.length > 0) {
        const x = Math.floor((e.touches[0].clientX - rect.left) * scaleX);
        const y = Math.floor((e.touches[0].clientY - rect.top) * scaleY);
        return { x, y };
    } else {
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);
        return { x, y };
    }
}

/**
 * Checks if the coordinates are within the canvas boundaries.
 * @param {number} x - X-coordinate
 * @param {number} y - Y-coordinate
 * @param {object} canvasObj - Canvas object
 * @returns {boolean}
 */
function isWithinCanvas(x, y, canvasObj) {
    return x >= 0 && x < canvasObj.canvas.width && y >= 0 && y < canvasObj.canvas.height;
}

/**
 * Wraps the coordinate if it goes beyond canvas boundaries.
 * @param {number} coord - Coordinate value
 * @param {number} max - Maximum value (width or height)
 * @returns {number}
 */
function wrapCoordinate(coord, max) {
    if (coord < 0) return max - 1;
    if (coord >= max) return 0;
    return coord;
}

/**
 * Determines the direction based on edge crossing.
 * @param {number} x - X-coordinate
 * @param {number} y - Y-coordinate
 * @param {object} canvasObj - Canvas object
 * @returns {string|null}
 */
function getDirectionFromEdge(x, y, canvasObj) {
    if (x < 0) return 'left';
    if (x >= canvasObj.canvas.width) return 'right';
    if (y < 0) return 'down';
    if (y >= canvasObj.canvas.height) return 'up';
    return null;
}

/**
 * Gets the neighbor canvas ID based on direction.
 * @param {string} currentId - Current canvas ID
 * @param {string} direction - Direction of the neighbor
 * @returns {string|null}
 */
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

/**
 * Draws a pixel or a brush based on the current brush size.
 * @param {object} canvasObj - Canvas object
 * @param {number} x - X-coordinate
 * @param {number} y - Y-coordinate
 * @param {string} color - Color to draw
 */
function drawPixel(canvasObj, x, y, color, targetColor = null, username = "unknown") {
    const ctx = canvasObj.ctx;
    ctx.fillStyle = color;
    ctx.imageSmoothingEnabled = false;

    drawBrush(ctx, x, y, Math.floor(pencilSize), color, canvasObj.id, targetColor, username);
}

/**
 * Draws a circular brush with configurable pixel size.
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {number} x - X-coordinate
 * @param {number} y - Y-coordinate
 * @param {number} size - Radius of the brush
 * @param {string} color - Color to draw
 * @param {string} canvasId - ID of the canvas
 */
function drawBrush(ctx, x, y, size, color, canvasId, targetColor = null, username = "unknown") {
    ctx.fillStyle = color;
    const radius = size / 2;
    const center = radius - 0.5;
	// get canvas
	const canvasObj = canvases.get(canvasId);
	if (!canvasObj) return;

    for (let yOffset = 0; yOffset < size; yOffset++) {
        for (let xOffset = 0; xOffset < size; xOffset++) {
            const distance = Math.sqrt(Math.pow(xOffset - center, 2) + Math.pow(yOffset - center, 2));
            if (distance < radius) {

				if (targetColor == null) {
                	ctx.fillRect(x + xOffset - radius + 1, y + yOffset - radius + 1, 1, 1);
					// set pixel data
					const key = `${x + xOffset - radius + 1},${y + yOffset - radius + 1}`;
					const pixelData = { color, user: username, timestamp: Date.now() };
					canvasObj.canvasData[key] = pixelData;
				} else {
					// only draw if the pixel is the target color
					if (getPixelColor(ctx, x + xOffset - radius + 1, y + yOffset - radius + 1) == targetColor) {
						ctx.fillRect(x + xOffset - radius + 1, y + yOffset - radius + 1, 1, 1);
						// set pixel data
						const key = `${x + xOffset - radius + 1},${y + yOffset - radius + 1}`;
						const pixelData = { color, user: username, timestamp: Date.now() };
						canvasObj.canvasData[key] = pixelData;
						
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

/**
 * Updates the selected color swatch.
 * @param {string} color - Selected color
 */
function updateColorSwatches(color) {
    colorSwatches.forEach(swatch => {
        swatch.classList.toggle('selected', swatch.getAttribute('data-color').toLowerCase() === color.toLowerCase());
    });
}

// Event Handlers

/**
 * Handles global mouse down events for drawing.
 * @param {MouseEvent} e 
 */
function handleMouseDown(e) {
    if (disableDrawing || e.button !== 0) return; // Only left-click

	if(e.target.closest == undefined) return;

    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper) return;

    const x = Number(targetCanvasWrapper.getAttribute('data-x'));
    const y = Number(targetCanvasWrapper.getAttribute('data-y'));
    const canvasId = `${x}|${y}`;
    const canvasObj = canvases.get(canvasId);
    if (canvasObj) {
        const tool = tools[currentTool];
        tool?.onMouseDown(e, canvasObj);
    }
}

/**
* Handles global touch start events for drawing.
* @param {TouchEvent} e 
*/
function handleTouchStart(e) {
	if (disableDrawing) return;
	const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
	if (!targetCanvasWrapper) return;

	const x = Number(targetCanvasWrapper.getAttribute('data-x'));
	const y = Number(targetCanvasWrapper.getAttribute('data-y'));
	const canvasId = `${x}|${y}`;
	const canvasObj = canvases.get(canvasId);
	if (canvasObj) {
		const tool = tools[currentTool];
		tool?.onMouseDown(e, canvasObj);
	}
}

/**
 * Handles global mouse move events for drawing.
 * @param {MouseEvent} e 
 */
function handleMouseMove(e) {
    if (!isDrawing) return;

	// make sure e.target.closest is defined
	if(e.target.closest == undefined) return

    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper || !currentCanvasObj) return;

    const x = Number(targetCanvasWrapper.getAttribute('data-x'));
    const y = Number(targetCanvasWrapper.getAttribute('data-y'));
    const canvasId = `${x}|${y}`;
    const canvasObj = canvases.get(canvasId);
    if (canvasObj) {

		// if canvasObj is not the same as currentCanvasObj, do onMouseUp on currentCanvasObj and onMouseDown on canvasObj
		if (canvasObj !== currentCanvasObj) {
			console.log("Mouse up on currentCanvasObj and mouse down on canvasObj");
			const tool = tools[currentTool];
			tool?.onMouseUp(e, currentCanvasObj);
			tool?.onMouseDown(e, canvasObj);
			currentCanvasObj = canvasObj;	
		}


        const tool = tools[currentTool];
        tool?.onMouseMove(e, canvasObj);
    }
}

/**
* Handles global touch move events for drawing.
* @param {TouchEvent} e 
*/
function handleTouchMove(e) {
	if (!isDrawing) return;
	const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
	if (!targetCanvasWrapper || !currentCanvasObj) return;

	const x = Number(targetCanvasWrapper.getAttribute('data-x'));
	const y = Number(targetCanvasWrapper.getAttribute('data-y'));
	const canvasId = `${x}|${y}`;
	const canvasObj = canvases.get(canvasId);
	if (canvasObj) {
		const tool = tools[currentTool];
		tool?.onMouseMove(e, canvasObj);
	}
}

/**
 * Handles global mouse up events for drawing.
 * @param {MouseEvent} e 
 */
function handleMouseUp(e) {
    if (!isDrawing) return;
	if(e.target.closest == undefined) return
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper || !currentCanvasObj) return;

    const x = Number(targetCanvasWrapper.getAttribute('data-x'));
    const y = Number(targetCanvasWrapper.getAttribute('data-y'));
    const canvasId = `${x}|${y}`;
    const canvasObj = canvases.get(canvasId);
    if (canvasObj) {
        const tool = tools[currentTool];
        tool?.onMouseUp(e, canvasObj);
    }
}

/**
* Handles global touch end events for drawing.
* @param {TouchEvent} e
*/
function handleTouchEnd(e) {
	if (!isDrawing) return;
	const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
	if (!targetCanvasWrapper || !currentCanvasObj) return;

	const x = Number(targetCanvasWrapper.getAttribute('data-x'));
	const y = Number(targetCanvasWrapper.getAttribute('data-y'));
	const canvasId = `${x}|${y}`;
	const canvasObj = canvases.get(canvasId);
	if (canvasObj) {
		const tool = tools[currentTool];
		tool?.onMouseUp(e, canvasObj);
	}
}

// Global Event Listeners for Drawing
document.addEventListener('mousedown', handleMouseDown);
document.addEventListener('mousemove', handleMouseMove);
document.addEventListener('mouseup', handleMouseUp);
// touch events
document.addEventListener('touchstart', handleTouchStart);
document.addEventListener('touchmove', handleTouchMove);
document.addEventListener('touchend', handleTouchEnd);


// Tooltip Handling
canvasMap.addEventListener('mousemove', (e) => {
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper) {
        hidePixelInfo();
        clearTimeout(hoverTimeout);
        lastHoveredPixel = null;
        return;
    }

    const x = Number(targetCanvasWrapper.getAttribute('data-x'));
    const y = Number(targetCanvasWrapper.getAttribute('data-y'));
    const canvasId = `${x}|${y}`;
    const canvasObj = canvases.get(canvasId);
    if (!canvasObj) {
        hidePixelInfo();
        clearTimeout(hoverTimeout);
        lastHoveredPixel = null;
        return;
    }

    const { x: pixelX, y: pixelY } = getCanvasCoordinates(e, canvasObj);
    const key = `${pixelX},${pixelY}`;
    const pixelData = canvasObj.canvasData?.[key] || null;

    const currentHoveredPixel = { canvasId, x: pixelX, y: pixelY };
    if (lastHoveredPixel && 
        lastHoveredPixel.canvasId === canvasId && 
        lastHoveredPixel.x === pixelX && 
        lastHoveredPixel.y === pixelY) {
        return; // Same pixel, do nothing
    }

    clearTimeout(hoverTimeout);
    lastHoveredPixel = currentHoveredPixel;

    if (pixelData && pixelData.user) {
        showPixelInfo(e, pixelData);
    } else {
        hidePixelInfo();
    }
});

/**
 * Displays pixel information tooltip.
 * @param {MouseEvent} e 
 * @param {object} info 
 */
function showPixelInfo(e, info) {
    tooltip.innerHTML = `
        <strong>Placed by:</strong> ${info.user.username}<br>
        <strong>At:</strong> ${new Date(info.timestamp).toLocaleString()}
    `;
    tooltip.style.left = `${e.pageX + GAP_SIZE}px`;
    tooltip.style.top = `${e.pageY + GAP_SIZE}px`;
    tooltip.style.display = 'block';
}

/**
 * Hides the pixel information tooltip.
 */
function hidePixelInfo() {
    tooltip.style.display = 'none';
    clearTimeout(hoverTimeout);
}

// Authentication and User Info Handling

/**
 * Updates the login/logout UI based on authentication status.
 */
function updateLoginStatusUI() {
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

/**
 * Fetches the authentication status from the server.
 */
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

// Tool Selection Event Listeners
toolButtons.forEach(button => {
    button.addEventListener('click', () => {
        toolButtons.forEach(btn => btn.classList.remove('selected'));
        button.classList.add('selected');
        currentTool = button.id.replace('-tool', '');
    });
});

// Color Selection Event Listeners
colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', (e) => {
        colorSwatches.forEach(s => s.classList.remove('selected'));
        e.target.classList.add('selected');
        currentColor = e.target.getAttribute('data-color');
    });
});

/**
 * Updates the color swatches to reflect the selected color.
 * @param {string} color 
 */
function updateColorSwatches(color) {
    colorSwatches.forEach(swatch => {
        swatch.classList.toggle('selected', swatch.getAttribute('data-color').toLowerCase() === color.toLowerCase());
    });
}

// Pencil Size Slider Event Listener
pencilSizeSlider.addEventListener('input', (e) => {
    pencilSize = parseInt(e.target.value, 10);
    pencilSizeDisplay.textContent = pencilSize;
});

// Canvas Visibility and Management

/**
 * Checks if a canvas is visible within the current viewport.
 * @param {number} x 
 * @param {number} y 
 * @returns {boolean}
 */
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

    let canvasWidth = canvasSize * zoom;
    let canvasHeight = canvasSize * zoom;

    return !(canvasX + canvasWidth < 0 || canvasX > viewportWidth || canvasY + canvasHeight < 0 || canvasY > viewportHeight);
}

/**
 * Updates the visibility of canvases based on their position.
 */
function updateVisibleCanvases() {
    canvases.forEach((canvasObj, canvasId) => {
        const [x, y] = canvasId.split('|').map(Number);
        const wrapper = document.querySelector(`.canvas-wrapper[data-x="${x}"][data-y="${y}"]`);

        if (isCanvasVisible(x, y)) {
            if (!canvasObj.rendered) {
                wrapper.style.display = 'block';
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

/**
 * Positions a canvas wrapper based on its coordinates.
 * @param {HTMLElement} wrapper 
 * @param {number} x 
 * @param {number} y 
 */
function positionCanvas(wrapper, x, y) {
    wrapper.style.left = `${x * (CANVAS_SIZE + GAP_SIZE)}px`;
    wrapper.style.top = `${-y * (CANVAS_SIZE + GAP_SIZE)}px`;
}

/**
 * Creates a new canvas wrapper at specified coordinates.
 * @param {number} x 
 * @param {number} y 
 * @param {boolean} alreadyLoaded 
 */
function createCanvasWrapper(x, y, alreadyLoaded = false) {
    const canvasId = generateCanvasId(x, y);

    if (canvases.has(canvasId) && !alreadyLoaded) {
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.classList.add('canvas-wrapper');
    wrapper.setAttribute('data-x', x);
    wrapper.setAttribute('data-y', y);
    positionCanvas(wrapper, x, y);

    const canvas = document.createElement('canvas');
    canvas.classList.add('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    wrapper.appendChild(canvas);

    // Add arrow buttons for adding neighboring canvases
    ['up', 'down', 'left', 'right'].forEach(direction => {
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
        canvasData: {},
        rendered: true
    };

    canvases.set(canvasId, canvasObj);
    socket.emit('join-canvas', { canvasId });

    // Initialize canvas data from server
    socket.on('init-canvas', async (data) => {
        if (data.canvasId === canvasId) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const canvasData = data.canvasData || {};
            /*Object.keys(canvasData).forEach(key => {
                const [px, py] = key.split(',').map(Number);
                ctx.fillStyle = canvasData[key].color;
                ctx.fillRect(px, py, 1, 1);
            });
			*/

			console.log(data.imageBlob);

			const imageBlob = data.imageBlob;
			
			const image = new Image();
			image.onload = () => {
				console.log("Image loaded");
				ctx.drawImage(image, 0, 0);
			};
			image.src = URL.createObjectURL(new Blob([imageBlob]));
			
            canvasObj.canvasData = canvasData;
            loadingIndicator.style.display = 'none';
            updateArrowsVisibility(x, y);
        }
    });
}

/**
 * Handles arrow button clicks to add neighboring canvases.
 * @param {number} currentX 
 * @param {number} currentY 
 * @param {string} direction 
 */
function handleArrowClick(currentX, currentY, direction) {
    if (!isAuthenticated) return;

    let newX = currentX;
    let newY = currentY;

    switch(direction) {
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

/**
 * Capitalizes the first letter of a string.
 * @param {string} str 
 * @returns {string}
 */
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Generates a canvas ID based on coordinates.
 * @param {number} x 
 * @param {number} y 
 * @returns {string}
 */
function generateCanvasId(x, y) {
    return `${x}|${y}`;
}

/**
 * Updates the visibility of arrow buttons based on neighboring canvases.
 * @param {number} x 
 * @param {number} y 
 */
function updateArrowsVisibility(x, y) {
    const directions = ['up', 'down', 'left', 'right'];
    directions.forEach(direction => {
        const neighborId = getNeighborCanvasId(generateCanvasId(x, y), direction);
        const wrapper = document.querySelector(`.canvas-wrapper[data-x="${x}"][data-y="${y}"]`);
        const arrow = wrapper?.querySelector(`.arrow.${direction}`);
        if (arrow) {
            arrow.style.display = canvases.has(neighborId) ? 'none' : 'block';
        }
    });
}

// Pan and Zoom Handling

/**
 * Initializes pan and zoom functionalities.
 */
function initPanAndZoom() {
    let isMouseDownPan = false;
    let lastMousePosition = { x: 0, y: 0 };
    let keysPressed = {};
	let isSpacePressed = false;

    // Mouse Event Listeners for Panning with Middle Button and Space + Drag
    document.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && isSpacePressed)) { // Middle button or Space + Left Click
            e.preventDefault();
			console.log("Panning");
            isPanning = true;
            isMouseDownPan = true;
            disableDrawing = true;
            lastMousePosition = { x: e.clientX, y: e.clientY };
            canvasMap.classList.add('grabbing');
        }

    });

    document.addEventListener('mousemove', (e) => {
        if (isPanning && isMouseDownPan){
			const deltaX = e.clientX - lastMousePosition.x;
			const deltaY = e.clientY - lastMousePosition.y;
			pan(deltaX, deltaY);
		}
        lastMousePosition = { x: e.clientX, y: e.clientY };
    });

    document.addEventListener('mouseup', (e) => {
        if ((isPanning && e.button === 1) || (isPanning && e.button === 0 && isSpacePressed)) { // Middle button release or Space + Left Click release
            isPanning = false;
            isMouseDownPan = false;
            disableDrawing = false;
            canvasMap.classList.remove('grabbing');
        }
    });

	// allow simulating touch events by pinning a point with alt and then dragging

	document.addEventListener('touchstart', touchStart);

	function touchStart (e) {
		if (e.touches.length === 2) {
			const touch1 = e.touches[0];
			const touch2 = e.touches[1];
			const touchCenter = {
				x: (touch1.clientX + touch2.clientX) / 2,
				y: (touch1.clientY + touch2.clientY) / 2
			};
			lastMousePosition = { x: touchCenter.x, y: touchCenter.y };
		}
	}

	var lastPinchDistance = -1;

	document.addEventListener('touchmove', touchMove);



	function touchMove (e) {
		console.log(e.touches.length)
		if (e.touches.length === 2) {
			console.log("Panning");
			const touch1 = e.touches[0];
			const touch2 = e.touches[1];
			const touchCenter = {
				x: (touch1.clientX + touch2.clientX) / 2,
				y: (touch1.clientY + touch2.clientY) / 2
			};
			const deltaX = touchCenter.x - lastMousePosition.x;
			const deltaY = touchCenter.y - lastMousePosition.y;
			pan(deltaX, deltaY);
			lastMousePosition = { x: touchCenter.x, y: touchCenter.y };

			const distance = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
			if (lastPinchDistance === -1) {
				lastPinchDistance = distance;
			}

			const pinchChange = distance - lastPinchDistance;
			// zoom on the center of the pinch, make sure we zoom faster if the pinch distance is larger
			const rect = canvasMap.getBoundingClientRect();
			const mouseX = touchCenter.x - rect.left;
			const mouseY = touchCenter.y - rect.top;
			const scaleFactor = 0.005; // Control zoom speed here
			const wheel = pinchChange

			// Apply exponential scaling for smoother zoom
			let newZoom = currentZoom * (1 + wheel * scaleFactor);

			// Keep zoom within bounds
			newZoom = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
			const zoomChange = newZoom / currentZoom;

			// Adjust panning to keep the mouse position in the same place
			currentPan.x -= mouseX * (zoomChange - 1);
			currentPan.y -= mouseY * (zoomChange - 1);

			currentZoom = newZoom;

			
		
			updateCanvasMapTransform();

			lastPinchDistance = distance;

		}
	}

	document.addEventListener('touchend', touchEnd);

	function touchEnd (e) {
		if (e.touches.length < 2) {
			isPanning = false;
			pinnedPoint = null;
			lastPinchDistance = -1;
		}
	}


    // Keyboard Event Listeners for Panning with WASD and Arrow Keys
    document.addEventListener('keydown', (e) => {
        if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            keysPressed[e.key] = true;
        }
        if (e.code === 'Space') {
            e.preventDefault();
            disableDrawing = true;
            canvasMap.classList.add('grabbing');
			isSpacePressed = true;
        }
    });

    document.addEventListener('keyup', (e) => {
        if (keysPressed[e.key]) {
            keysPressed[e.key] = false;
        }
        if (e.code === 'Space') {
            disableDrawing = false;
            canvasMap.classList.remove('grabbing');
			isSpacePressed = false;
        }
    });

    // Mouse Wheel for Zooming
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
		newZoom = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
		const zoomChange = newZoom / currentZoom;
	
		// Adjust panning to keep the mouse position in the same place
		currentPan.x -= mouseX * (zoomChange - 1);
		currentPan.y -= mouseY * (zoomChange - 1);
	
		currentZoom = newZoom;
		updateCanvasMapTransform();

    }, { passive: false });

    // Smooth Panning with Keyboard
    function smoothPan() {
        if (keysPressed['w'] || keysPressed['ArrowUp']) pan(0, PAN_SPEED);
        if (keysPressed['s'] || keysPressed['ArrowDown']) pan(0, -PAN_SPEED);
        if (keysPressed['a'] || keysPressed['ArrowLeft']) pan(PAN_SPEED, 0);
        if (keysPressed['d'] || keysPressed['ArrowRight']) pan(-PAN_SPEED, 0);
        requestAnimationFrame(smoothPan);
    }
	
    smoothPan();

    /**
     * Pans the canvas map by the specified deltas.
     * @param {number} deltaX 
     * @param {number} deltaY 
     */
    function pan(deltaX, deltaY) {
        currentPan.x += deltaX;
        currentPan.y += deltaY;
        updateCanvasMapTransform();
    }

}

/**
 * Updates the transformation of the canvas map based on pan and zoom.
 */
function updateCanvasMapTransform() {
    canvasMap.style.transform = `translate(${currentPan.x}px, ${currentPan.y}px) scale(${currentZoom})`;
    updateVisibleCanvases();
}

// Canvas Management

/**
 * Initializes the canvas map on page load.
 */
window.onload = () => {
    fetchAuthStatus();

    // Prevent native pinch-to-zoom and other default behaviors
    ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'dblclick'].forEach(event => {
        document.addEventListener(event, (e) => e.preventDefault(), { passive: false });
    });

    // Initialize pan and zoom functionalities
    initPanAndZoom();

    // Request initial canvas list from server
    socket.emit('request-canvas-list');

    socket.on('update-canvas-list', async ({ canvasList }) => {
        canvasList.forEach(canvasId => {
            const [x, y] = canvasId.split('|').map(Number);
            createCanvasWrapper(x, y);
        });

        if (!canvasList.includes('0|0')) {
            createCanvasWrapper(0, 0);
        }

        updateVisibleCanvases();
    });

    // Handle incoming draw-pixel events
    socket.on('draw', async (data) => {
        const { canvasId, x, y, color, size, tool, extra_data, user, timestamp } = data;
        const canvasObj = canvases.get(canvasId);
        if (!canvasObj) return;

        canvasObj.ctx.fillStyle = color;
        canvasObj.ctx.imageSmoothingEnabled = false;

        
        drawBrush(canvasObj.ctx, x, y, Math.floor(size), color, canvasId, extra_data.targetColor, user);
     
    });
};

// Prevent Ctrl + Zoom on Desktop
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) {
        e.preventDefault();
    }
});
