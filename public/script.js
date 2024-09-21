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

// Vertex Shader Source
const vertexShaderSource = `#version 300 es
    precision mediump float;
    in vec2 a_position;
    in vec2 a_texCoord;
    out vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
    }
`;

// Fragment Shader Source
const fragmentShaderSource = `#version 300 es
    precision mediump float;
    in vec2 v_texCoord;
    out vec4 outColor;
    uniform sampler2D u_texture;
    void main() {
        outColor = texture(u_texture, v_texCoord);
    }
`;

// Utility function to create and compile a shader
function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
    if (success) {
        return shader;
    }
    console.error('Shader compilation failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
}

// Utility function to create a shader program
function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    if (!program) return null;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    const success = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (success) {
        return program;
    }
    console.error('Program linking failed:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
}

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
const canvases = new Map(); // key: 'x|y', value: { canvas, gl, program, vao, texture, pixelData, needsUpdate, updateQueue }

// Unique Client ID
let clientId = null;

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
            targetColor: null,
            ...extra_data
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

    onMouseUp(e, canvasObj) {
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
        // Emit draw event with clientId
        socket.emit('draw', {
            clientId,
            canvasId: canvasObj.id,
            x,
            y,
            color: drawColor,
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

        const targetColor = getPixelColor(canvasObj, x, y);
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
        const color = getPixelColor(canvasObj, x, y);
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

function getCanvasCoordinates(e, canvasObj) {
    const rect = canvasObj.canvas.getBoundingClientRect();
    const scaleX = CANVAS_SIZE / rect.width;
    const scaleY = CANVAS_SIZE / rect.height;

    let clientX, clientY;

    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    const x = Math.floor((clientX - rect.left) * scaleX);
    const y = CANVAS_SIZE - 1 - Math.floor((clientY - rect.top) * scaleY);
    return { x, y };
}

function isWithinCanvas(x, y, canvasObj) {
    return x >= 0 && x < CANVAS_SIZE && y >= 0 && y < CANVAS_SIZE;
}

function wrapCoordinate(coord, max) {
    if (coord < 0) return max - 1;
    if (coord >= max) return 0;
    return coord;
}

function getDirectionFromEdge(x, y, canvasObj) {
    if (x < 0) return 'left';
    if (x >= canvasObj.canvas.width) return 'right';
    if (y < 0) return 'down';
    if (y >= canvasObj.canvas.height) return 'up';
    return null;
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

function drawPixel(canvasObj, x, y, color, username = "unknown") {
    if (!isWithinCanvas(x, y, canvasObj)) return;

    const rgba = hexToRgba(color);
    const index = (y * CANVAS_SIZE + x) * 4;
    canvasObj.pixelData.set([rgba.r, rgba.g, rgba.b, 255], index);

    canvasObj.needsUpdate = true; // Set flag for texture update
}

function drawBrush(gl, canvasObj, x, y, size, color, canvasId, username = "unknown") {
    const radius = Math.floor(size / 2);
    const rgba = hexToRgba(color);

    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy <= radius * radius) {
                const px = x + dx;
                const py = y + dy;
                if (px >= 0 && px < CANVAS_SIZE && py >= 0 && py < CANVAS_SIZE) {
                    const index = (py * CANVAS_SIZE + px) * 4;
                    canvasObj.pixelData.set([rgba.r, rgba.g, rgba.b, 255], index);
                }
            }
        }
    }

    canvasObj.needsUpdate = true; // Set flag for texture update
}

function hexToRgba(hex) {
    let bigint = parseInt(hex.slice(1), 16);
    let r = (bigint >> 16) & 255;
    let g = (bigint >> 8) & 255;
    let b = bigint & 255;
    return { r, g, b, a: 255 };
}

function rgbaToHex(rgba) {
    return `#${((1 << 24) + (rgba.r << 16) + (rgba.g << 8) + rgba.b).toString(16).slice(1).toUpperCase()}`;
}

function getPixelColor(canvasObj, x, y) {
    const index = (y * CANVAS_SIZE + x) * 4;
    const r = canvasObj.pixelData[index];
    const g = canvasObj.pixelData[index + 1];
    const b = canvasObj.pixelData[index + 2];
    return rgbaToHex({ r, g, b, a: 255 });
}

function updateColorSwatches(color) {
    colorSwatches.forEach(swatch => {
        swatch.classList.toggle('selected', swatch.getAttribute('data-color').toLowerCase() === color.toLowerCase());
    });
}

// Event Handlers

function handleMouseDown(e) {
    if (disableDrawing || e.button !== 0) return;

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

function handleMouseMove(e) {
    if (!isDrawing) return;

    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper || !currentCanvasObj) return;

    const x = Number(targetCanvasWrapper.getAttribute('data-x'));
    const y = Number(targetCanvasWrapper.getAttribute('data-y'));
    const canvasId = `${x}|${y}`;
    const canvasObj = canvases.get(canvasId);
    if (canvasObj) {
        if (canvasObj !== currentCanvasObj) {
            const tool = tools[currentTool];
            tool?.onMouseUp(e, currentCanvasObj);
            tool?.onMouseDown(e, canvasObj);
            currentCanvasObj = canvasObj;
        }

        const tool = tools[currentTool];
        tool?.onMouseMove(e, canvasObj);
    }
}

function handleMouseUp(e) {
    if (!isDrawing) return;
    const targetCanvasWrapper = e.target.closest('.canvas-wrapper');
    if (!targetCanvasWrapper || !currentCanvasObj) {
        const tool = tools[currentTool];
        tool?.onMouseUp(e, null);
        return;
    }

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
    const key = (pixelY * CANVAS_SIZE) + pixelX;
    const pixelData = canvasObj.pixelData.slice(key * 4, key * 4 + 4); // Get RGBA values

    const currentHoveredPixel = { 
        canvasId, 
        x: pixelX, 
        y: pixelY, 
        color: rgbaToHex({ r: pixelData[0], g: pixelData[1], b: pixelData[2], a: pixelData[3] }) 
    };
    if (lastHoveredPixel && 
        lastHoveredPixel.canvasId === canvasId && 
        lastHoveredPixel.x === pixelX && 
        lastHoveredPixel.y === pixelY) {
        return; // Same pixel, do nothing
    }

    clearTimeout(hoverTimeout);
    lastHoveredPixel = currentHoveredPixel;

    // Delay tooltip display for better UX
    hoverTimeout = setTimeout(() => {
        showPixelInfo(e, currentHoveredPixel);
    }, 300);
});

function showPixelInfo(e, info) {
    tooltip.innerHTML = `
        <strong>Color:</strong> ${info.color}<br>
        <strong>Position:</strong> (${info.x}, ${info.y})<br>
        <strong>Canvas:</strong> ${info.canvasId}<br>
    `;
    tooltip.style.left = `${e.pageX + GAP_SIZE}px`;
    tooltip.style.top = `${e.pageY + GAP_SIZE}px`;
    tooltip.style.display = 'block';
}

function hidePixelInfo() {
    tooltip.style.display = 'none';
    clearTimeout(hoverTimeout);
}

// Authentication and User Info Handling

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

// Pencil Size Slider Event Listener
pencilSizeSlider.addEventListener('input', (e) => {
    pencilSize = parseInt(e.target.value, 10);
    pencilSizeDisplay.textContent = pencilSize;
});

// Canvas Visibility and Management

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

function positionCanvas(wrapper, x, y) {
    wrapper.style.left = `${x * (CANVAS_SIZE + GAP_SIZE)}px`;
    wrapper.style.top = `${-y * (CANVAS_SIZE + GAP_SIZE)}px`;
}

function initializeWebGL(canvas) {
    const gl = canvas.getContext('webgl2');
    if (!gl) {
        console.error('WebGL2 not supported in this browser.');
        return null;
    }

    // Set pixel storage mode
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // Ensure tight packing

    // Compile shaders and link program
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    const program = createProgram(gl, vertexShader, fragmentShader);
    if (!program) {
        return null;
    }

    // Get attribute and uniform locations once
    const positionAttributeLocation = gl.getAttribLocation(program, 'a_position');
    const texCoordAttributeLocation = gl.getAttribLocation(program, 'a_texCoord');
    const textureUniformLocation = gl.getUniformLocation(program, 'u_texture');

    // Create and bind VAO once
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    // Define interleaved vertex data (position and texCoord)
    const vertices = new Float32Array([
        // Position    // TexCoord
        -1, -1,       0, 0,
         1, -1,       1, 0,
        -1,  1,       0, 1,
        -1,  1,       0, 1,
         1, -1,       1, 0,
         1,  1,       1, 1,
    ]);

    // Create and setup vertex buffer
    const vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const stride = 4 * Float32Array.BYTES_PER_ELEMENT; // 4 floats per vertex

    // Set up position attribute
    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.vertexAttribPointer(
        positionAttributeLocation,
        2,
        gl.FLOAT,
        false,
        stride,
        0
    );

    // Set up texCoord attribute
    gl.enableVertexAttribArray(texCoordAttributeLocation);
    gl.vertexAttribPointer(
        texCoordAttributeLocation,
        2,
        gl.FLOAT,
        false,
        stride,
        2 * Float32Array.BYTES_PER_ELEMENT
    );

    // Create and setup texture
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    
    // Allocate immutable texture storage using texStorage2D
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, CANVAS_SIZE, CANVAS_SIZE);

    // Initialize texture data efficiently
    const initialData = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE * 4).fill(255); // White canvas
    gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        CANVAS_SIZE,
        CANVAS_SIZE,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        initialData
    );

    // Set texture parameters once
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    // Unbind VAO and texture to avoid accidental modifications
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Initialize pixelData
    const pixelData = new Uint8Array(initialData);

    // Initial render
    renderCanvas(gl, program, vao, texture, textureUniformLocation);

    return {
        gl,
        program,
        vao,
        texture,
        textureUniformLocation,
        pixelData,
        needsUpdate: false, // Initialize with no updates needed
        updateQueue: [] // Queue to accumulate pixel updates
    };
}

// State cache to minimize WebGL state changes (removed global cache)

// Rendering Loop to Batch Texture Updates
function renderLoop() {
    canvases.forEach(canvasObj => {
        if (canvasObj.needsUpdate && canvasObj.updateQueue.length > 0) {
            updateTexture(canvasObj);
        }
    });

    requestAnimationFrame(renderLoop);
}

// Update the texture with new pixel data from the queue
function updateTexture(canvasObj) {
    const { gl, texture, pixelData, program, vao, textureUniformLocation, updateQueue } = canvasObj;

    // Debug: Log number of updates
    console.log(`Updating texture for canvas ${canvasObj.id} with ${updateQueue.length} pixels`);

    // Process all queued updates
    updateQueue.forEach(pixel => {
        const { x, y, color } = pixel;
        if (!isWithinCanvas(x, y, canvasObj)) return;

        const rgba = hexToRgba(color);
        const index = (y * CANVAS_SIZE + x) * 4;
        pixelData.set([rgba.r, rgba.g, rgba.b, 255], index);
    });

    // Clear the update queue after processing
    canvasObj.updateQueue = [];

    // Update the texture using texSubImage2D
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        CANVAS_SIZE,
        CANVAS_SIZE,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixelData
    );
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Render the updated texture
    renderCanvas(gl, program, vao, texture, textureUniformLocation);
}

// Render the texture onto the canvas
function renderCanvas(gl, program, vao, texture, textureUniformLocation) {
    gl.viewport(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    gl.clearColor(1, 1, 1, 1); // Clear to white
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Use program
    gl.useProgram(program);

    // Bind VAO
    gl.bindVertexArray(vao);

    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(textureUniformLocation, 0);

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Unbind VAO and texture to clean up
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
}

// Create a canvas wrapper and initialize WebGL
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

    ['up', 'down', 'left', 'right'].forEach(direction => {
        const arrow = document.createElement('button');
        arrow.classList.add('arrow', direction);
        arrow.title = `Add Canvas ${capitalize(direction)}`;
        arrow.innerHTML = `<i class="fas fa-arrow-${direction}"></i>`;
        arrow.addEventListener('click', () => handleArrowClick(x, y, direction));
        wrapper.appendChild(arrow);
    });

    canvasMap.appendChild(wrapper);

    const glObjects = initializeWebGL(canvas);
    if (!glObjects) {
        console.error(`Failed to initialize WebGL2 for canvas ${canvasId}`);
        return;
    }

    const canvasObj = {
        id: canvasId,
        x,
        y,
        canvas,
        gl: glObjects.gl,
        program: glObjects.program,
        vao: glObjects.vao,
        texture: glObjects.texture,
        pixelData: glObjects.pixelData,
        needsUpdate: false, // Initially, no updates needed
        updateQueue: [], // Initialize empty update queue
        rendered: true
    };

    canvases.set(canvasId, canvasObj);
    socket.emit('join-canvas', { canvasId });

    // Note: Removed socket.on('init-canvas') from here

    return wrapper;
}

// Handle arrow button clicks to add new canvases
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

// Capitalize first letter
function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// Generate canvas ID from coordinates
function generateCanvasId(x, y) {
    return `${x}|${y}`;
}

// Update the visibility of canvas arrows based on existing neighbors
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

function initPanAndZoom() {
    let isMouseDownPan = false;
    let lastMousePosition = { x: 0, y: 0 };
    let keysPressed = {};
    let isSpacePressed = false;

    document.addEventListener('mousedown', (e) => {
        if (e.button === 1 || (e.button === 0 && isSpacePressed)) {
            e.preventDefault();
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
        if ((isPanning && e.button === 1) || (isPanning && e.button === 0 && isSpacePressed)) {
            isPanning = false;
            isMouseDownPan = false;
            disableDrawing = false;
            canvasMap.classList.remove('grabbing');
        }
    });

    document.addEventListener('touchstart', touchStart, { passive: false });

    function touchStart (e) {
        if (e.touches.length === 2) {
            e.preventDefault(); // Prevent default pinch-to-zoom
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];
            const touchCenter = {
                x: (touch1.clientX + touch2.clientX) / 2,
                y: (touch1.clientY + touch2.clientY) / 2
            };
            lastMousePosition = { x: touchCenter.x, y: touchCenter.y };
        }
    }

    let lastPinchDistance = -1;

    document.addEventListener('touchmove', touchMove, { passive: false });

    function touchMove (e) {
        if (e.touches.length === 2) {
            e.preventDefault(); // Prevent default pinch-to-zoom
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
            const rect = canvasMap.getBoundingClientRect();
            const mouseX = touchCenter.x - rect.left;
            const mouseY = touchCenter.y - rect.top;
            const scaleFactor = 0.005;
            const wheel = pinchChange;

            let newZoom = currentZoom * (1 + wheel * scaleFactor);
            newZoom = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
            const zoomChangeFactor = newZoom / currentZoom;

            currentPan.x -= mouseX * (zoomChangeFactor - 1);
            currentPan.y -= mouseY * (zoomChangeFactor - 1);

            currentZoom = newZoom;
            updateCanvasMapTransform();

            lastPinchDistance = distance;
        }
    }

    document.addEventListener('touchend', touchEnd, { passive: false });

    function touchEnd (e) {
        if (e.touches.length < 2) {
            isPanning = false;
            lastPinchDistance = -1;
        }
    }

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

    document.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = canvasMap.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const scaleFactor = 0.1;
        const wheelDirection = e.deltaY < 0 ? 1 : -1;

        let newZoom = currentZoom * (1 + wheelDirection * scaleFactor);
        newZoom = Math.min(Math.max(newZoom, MIN_ZOOM), MAX_ZOOM);
        const zoomChangeFactor = newZoom / currentZoom;

        currentPan.x -= mouseX * (zoomChangeFactor - 1);
        currentPan.y -= mouseY * (zoomChangeFactor - 1);

        currentZoom = newZoom;
        updateCanvasMapTransform();
    }, { passive: false });

    function smoothPan() {
        if (keysPressed['w'] || keysPressed['ArrowUp']) pan(0, PAN_SPEED);
        if (keysPressed['s'] || keysPressed['ArrowDown']) pan(0, -PAN_SPEED);
        if (keysPressed['a'] || keysPressed['ArrowLeft']) pan(PAN_SPEED, 0);
        if (keysPressed['d'] || keysPressed['ArrowRight']) pan(-PAN_SPEED, 0);
        requestAnimationFrame(smoothPan);
    }

    smoothPan();

    function pan(deltaX, deltaY) {
        currentPan.x += deltaX;
        currentPan.y += deltaY;
        updateCanvasMapTransform();
    }
}

function updateCanvasMapTransform() {
    canvasMap.style.transform = `translate(${currentPan.x}px, ${currentPan.y}px) scale(${currentZoom})`;
    updateVisibleCanvases();
}

// Canvas Management

window.onload = () => {
    fetchAuthStatus();

    socket.on('connect', () => {
        clientId = socket.id;
        console.log('Connected to socket.io with ID:', clientId);
    });

    // Prevent default gestures and double-clicks
    ['gesturestart', 'gesturechange', 'gestureend', 'touchmove', 'dblclick'].forEach(event => {
        document.addEventListener(event, (e) => e.preventDefault(), { passive: false });
    });

    initPanAndZoom();

    socket.emit('request-canvas-list');

    socket.on('update-canvas-list', async ({ canvasList }) => {
        console.log('Received canvas list:', canvasList);
        canvasList.forEach(canvasId => {
            const [x, y] = canvasId.split('|').map(Number);
            createCanvasWrapper(x, y);
        });

        if (!canvasList.includes('0|0')) {
            createCanvasWrapper(0, 0);
        }

        updateVisibleCanvases();
    });

    // Moved 'init-canvas' listener outside 'createCanvasWrapper'
    socket.on('init-canvas', async (data) => {
        const { canvasId, canvasData } = data;
        console.log(`Initializing canvas ${canvasId} with data:`, canvasData);

        const canvasObj = canvases.get(canvasId);
        if (!canvasObj) {
            console.warn(`Received init-canvas for unknown canvasId: ${canvasId}`);
            return;
        }

        // Update pixelData
        for (let py = 0; py < CANVAS_SIZE; py++) {
            for (let px = 0; px < CANVAS_SIZE; px++) {
                const index = (py * CANVAS_SIZE + px) * 4;
                const pixel = canvasData[py * CANVAS_SIZE + px];
                const color = pixel?.color || '#FFFFFF';
                const rgba = hexToRgba(color);
                canvasObj.pixelData.set([rgba.r, rgba.g, rgba.b, 255], index);
            }
        }

        canvasObj.needsUpdate = true; // Flag for initial texture update
        // The rendering loop will handle the texture update
    });

    socket.on('update-canvas', async (data) => {
        const { canvasId, updatedPixels } = data;
    
        const canvasObj = canvases.get(canvasId);
        if (!canvasObj) {
            console.warn(`Received update-canvas for unknown canvasId: ${canvasId}`);
            return;
        }

        // Accumulate pixel updates
        updatedPixels.forEach(pixel => {
            const { x, y, color } = pixel;
            canvasObj.updateQueue.push({ x, y, color });
        });

        canvasObj.needsUpdate = true; // Flag to update in rendering loop
    });

    // Initialize rendering loop
    requestAnimationFrame(renderLoop);
};

// Prevent Ctrl + Zoom on Desktop
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '-', '=', '0'].includes(e.key)) {
        e.preventDefault();
    }
});
