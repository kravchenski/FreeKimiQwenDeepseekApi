export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface GapResult {
  x: number;
  y: number;
  score: number;
  stage?: 'color' | 'enclosed' | 'edges' | 'ncc';
}

export interface GapOptions {
  threshold?: number;
  refine?: number;
}

const DEFAULT_THRESHOLD = 0.35;
const DEFAULT_REFINE = 8;
const MAX_ENCLOSED_HOLE_AREA = 1800;
const MAX_COLOR_HOLE_AREA = 2500;

function luminance(image: RgbaImage): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let index = 0; index < width * height; index++) {
    const pixel = index * 4;
    out[index] = 0.299 * data[pixel] + 0.587 * data[pixel + 1] + 0.114 * data[pixel + 2];
  }
  return out;
}

function alphaMask(image: RgbaImage): Uint8Array | undefined {
  const pixels = image.width * image.height;
  const { data } = image;
  let transparent = false;
  for (let index = 0; index < pixels; index++) {
    if (data[index * 4 + 3] < 250) {
      transparent = true;
      break;
    }
  }
  if (!transparent) return undefined;
  const mask = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index++) mask[index] = data[index * 4 + 3] >= 128 ? 1 : 0;
  return mask;
}

function sobelMagnitude(lum: Float32Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const topLeft = lum[index - width - 1];
      const top = lum[index - width];
      const topRight = lum[index - width + 1];
      const left = lum[index - 1];
      const right = lum[index + 1];
      const bottomLeft = lum[index + width - 1];
      const bottom = lum[index + width];
      const bottomRight = lum[index + width + 1];
      const gx = -topLeft - 2 * left - bottomLeft + topRight + 2 * right + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      out[index] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return out;
}

interface ColumnData {
  profile: Float64Array;
  valid: Uint8Array;
}

function columnProfile(mag: Float32Array, width: number, height: number, mask?: Uint8Array): ColumnData {
  const profile = new Float64Array(width);
  const valid = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y < height; y++) {
      const index = y * width + x;
      if (mask && !mask[index]) continue;
      sum += mag[index];
      count++;
    }
    profile[x] = sum;
    valid[x] = x > 0 && x < width - 1 && count > 0 ? 1 : 0;
  }
  return { profile, valid };
}

function bestShift(background: ColumnData, piece: ColumnData): number {
  const width = piece.profile.length;
  const pieceColumns: number[] = [];
  for (let index = 0; index < width; index++) if (piece.valid[index]) pieceColumns.push(index);
  if (pieceColumns.length < 8) return -1;
  let pieceMean = 0;
  for (const index of pieceColumns) pieceMean += piece.profile[index];
  pieceMean /= pieceColumns.length;
  const centeredPiece = new Map<number, number>();
  let pieceNorm = 0;
  for (const index of pieceColumns) {
    const centered = piece.profile[index] - pieceMean;
    centeredPiece.set(index, centered);
    pieceNorm += centered * centered;
  }
  pieceNorm = Math.sqrt(pieceNorm);
  if (!pieceNorm) return -1;
  let bestScore = -Infinity;
  let bestShift = -1;
  for (let shift = 0; shift + width <= background.profile.length; shift++) {
    let windowMean = 0;
    let usable = true;
    for (const index of pieceColumns) {
      const position = shift + index;
      if (!background.valid[position]) {
        usable = false;
        break;
      }
      windowMean += background.profile[position];
    }
    if (!usable) continue;
    windowMean /= pieceColumns.length;
    let dot = 0;
    let bgNorm = 0;
    for (const index of pieceColumns) {
      const centered = background.profile[shift + index] - windowMean;
      dot += centered * centeredPiece.get(index)!;
      bgNorm += centered * centered;
    }
    const score = bgNorm ? dot / (Math.sqrt(bgNorm) * pieceNorm) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestShift = shift;
    }
  }
  return bestShift;
}

function ncc2d(
  bgMag: Float32Array,
  bgWidth: number,
  bgHeight: number,
  pieceMag: Float32Array,
  pieceWidth: number,
  pieceHeight: number,
  mask: Uint8Array | undefined,
  offsetX: number,
  offsetY: number,
): number {
  let count = 0;
  let bgSum = 0;
  let pieceSum = 0;
  for (let py = 0; py < pieceHeight; py++) {
    const bgRow = (offsetY + py) * bgWidth + offsetX;
    const pieceRow = py * pieceWidth;
    for (let px = 0; px < pieceWidth; px++) {
      const pieceIndex = pieceRow + px;
      if (px === 0 || px === pieceWidth - 1 || py === 0 || py === pieceHeight - 1) continue;
      if (mask && !mask[pieceIndex]) continue;
      count++;
      bgSum += bgMag[bgRow + px];
      pieceSum += pieceMag[pieceIndex];
    }
  }
  if (!count) return 0;
  const bgMean = bgSum / count;
  const pieceMean = pieceSum / count;
  let dot = 0;
  let bgNorm = 0;
  let pieceNorm = 0;
  for (let py = 0; py < pieceHeight; py++) {
    const bgRow = (offsetY + py) * bgWidth + offsetX;
    const pieceRow = py * pieceWidth;
    for (let px = 0; px < pieceWidth; px++) {
      const pieceIndex = pieceRow + px;
      if (px === 0 || px === pieceWidth - 1 || py === 0 || py === pieceHeight - 1) continue;
      if (mask && !mask[pieceIndex]) continue;
      const pieceValue = pieceMag[pieceIndex] - pieceMean;
      const bgValue = bgMag[bgRow + px] - bgMean;
      dot += bgValue * pieceValue;
      bgNorm += bgValue * bgValue;
      pieceNorm += pieceValue * pieceValue;
    }
  }
  const denominator = Math.sqrt(bgNorm) * Math.sqrt(pieceNorm);
  return denominator ? dot / denominator : 0;
}

function brightNeutral(r: number, g: number, b: number, lum: number): boolean {
  return lum > 175 && Math.abs(r - g) < 20 && Math.max(r, g) - b < 32;
}

function nonGreen(r: number, g: number, b: number, lum: number): boolean {
  return !(g > r && g - b > 25) && lum > 70;
}

const MAX_SHIFT_Y = 16;

interface Blob {
  cx: number;
  cy: number;
  area: number;
}

function blobs(
  image: RgbaImage,
  keepPixel: (r: number, g: number, b: number, lum: number) => boolean,
): Blob[] {
  const { width, height, data } = image;
  const total = width * height;
  const keep = new Uint8Array(total);
  for (let index = 0; index < total; index++) {
    const pixel = index * 4;
    const r = data[pixel]!;
    const g = data[pixel + 1]!;
    const b = data[pixel + 2]!;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    keep[index] = keepPixel(r, g, b, lum) ? 1 : 0;
  }
  const minArea = Math.max(150, Math.floor(0.01 * total));
  const maxArea = Math.floor(total * 0.5);
  const label = new Int32Array(width * height).fill(-1);
  const stack: number[] = [];
  const found: Blob[] = [];
  let id = 0;
  for (let start = 0; start < width * height; start++) {
    if (!keep[start] || label[start] >= 0) continue;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    stack.length = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const index = stack.pop()!;
      area++;
      sumX += index % width;
      sumY += (index / width) | 0;
      const x = index % width;
      const y = (index / width) | 0;
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (keep[next] && label[next] < 0) {
          label[next] = id;
          stack.push(next);
        }
      }
    }
    id++;
    if (area >= minArea && area <= maxArea) found.push({ cx: sumX / area, cy: sumY / area, area });
  }
  found.sort((a, b) => b.area - a.area);
  return found.slice(0, 8);
}

function enclosedBlobs(image: RgbaImage): Blob[] {
  const { width, height } = image;
  const mag = sobelMagnitude(luminance(image), width, height);
  const total = width * height;
  const edge = new Uint8Array(total);
  for (let index = 0; index < total; index++) edge[index] = mag[index] > 50 ? 1 : 0;
  const grown = new Uint8Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let dy = -2; dy <= 2 && !on; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (edge[ny * width + nx]) {
            on = 1;
            break;
          }
        }
      }
      grown[y * width + x] = on;
    }
  }
  const outside = new Uint8Array(total);
  const stack: number[] = [];
  for (let x = 0; x < width; x++) stack.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y++) stack.push(y * width, y * width + width - 1);
  while (stack.length) {
    const index = stack.pop()!;
    if (outside[index] || grown[index]) continue;
    outside[index] = 1;
    const x = index % width;
    const y = (index / width) | 0;
    if (x > 0) stack.push(index - 1);
    if (x < width - 1) stack.push(index + 1);
    if (y > 0) stack.push(index - width);
    if (y < height - 1) stack.push(index + width);
  }
  const minArea = Math.max(150, Math.floor(0.01 * total));
  const maxArea = Math.floor(total * 0.5);
  const label = new Int32Array(total).fill(-1);
  const found: Blob[] = [];
  let id = 0;
  for (let start = 0; start < total; start++) {
    if (outside[start] || grown[start] || label[start] >= 0) continue;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    stack.length = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const index = stack.pop()!;
      area++;
      const x = index % width;
      const y = (index / width) | 0;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const next of [index - 1, index + 1, index - width, index + width]) {
        if (next < 0 || next >= total || outside[next] || grown[next] || label[next] >= 0) continue;
        if (next === index - 1 && x === 0) continue;
        if (next === index + 1 && x === width - 1) continue;
        label[next] = id;
        stack.push(next);
      }
    }
    id++;
    const touchesBorder = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
    if (area >= minArea && area <= maxArea && !touchesBorder) {
      found.push({ cx: sumX / area, cy: sumY / area, area });
    }
  }
  found.sort((a, b) => b.area - a.area);
  return found.slice(0, 6);
}

function edgeShapeBlobs(image: RgbaImage): Blob[] {
  const { width, height } = image;
  const mag = sobelMagnitude(luminance(image), width, height);
  const total = width * height;
  const keep = new Uint8Array(total);
  for (let index = 0; index < total; index++) keep[index] = mag[index] > 30 ? 1 : 0;
  const minArea = Math.max(150, Math.floor(0.01 * total));
  const maxArea = Math.floor(total * 0.5);
  const label = new Int32Array(total).fill(-1);
  const stack: number[] = [];
  const found: Blob[] = [];
  let id = 0;
  for (let start = 0; start < total; start++) {
    if (!keep[start] || label[start] >= 0) continue;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    stack.length = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const index = stack.pop()!;
      area++;
      const x = index % width;
      const y = (index / width) | 0;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const next of [index - 1, index + 1, index - width, index + width]) {
        if (next < 0 || next >= total || !keep[next] || label[next] >= 0) continue;
        if (next === index - 1 && x === 0) continue;
        if (next === index + 1 && x === width - 1) continue;
        label[next] = id;
        stack.push(next);
      }
    }
    id++;
    const touchesBorder = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
    if (area >= minArea && area <= maxArea && !touchesBorder) {
      found.push({ cx: sumX / area, cy: sumY / area, area });
    }
  }
  found.sort((a, b) => b.area - a.area);
  return found.slice(0, 8);
}

function votePair(holes: Blob[], shapes: Blob[], maxWidth: number): { hole: Blob; shape: Blob; dy: number } | null {
  let pair: { hole: Blob; shape: Blob; dy: number } | null = null;
  for (const hole of holes) {
    for (const shape of shapes) {
      const x = hole.cx - shape.cx;
      if (x < 0 || x > maxWidth) continue;
      const dy = Math.abs(hole.cy - shape.cy);
      if (dy > MAX_SHIFT_Y) continue;
      if (!pair || dy < pair.dy) pair = { hole, shape, dy };
    }
  }
  return pair;
}

export function debugStages(background: RgbaImage, piece: RgbaImage): {
  colorHoles: Blob[];
  colorShapes: Blob[];
  enclosedHoles: Blob[];
  enclosedShapes: Blob[];
  colorPair: { hole: Blob; shape: Blob; dy: number } | null;
  enclosedPair: { hole: Blob; shape: Blob; dy: number } | null;
  edgeShapes: Blob[];
  edgePair: { hole: Blob; shape: Blob; dy: number } | null;
} {
  const maxWidth = background.width - piece.width;
  const colorHoles = blobs(background, brightNeutral).filter(h => h.area <= MAX_COLOR_HOLE_AREA);
  const colorShapes = [...blobs(piece, nonGreen), ...blobs(piece, brightNeutral)];
  const colorPair = votePair(colorHoles, colorShapes, maxWidth);
  const enclosedHoles = enclosedBlobs(background).filter(h => h.area <= MAX_ENCLOSED_HOLE_AREA);
  const enclosedShapes = enclosedBlobs(piece);
  const enclosedPair = votePair(enclosedHoles, enclosedShapes, maxWidth)
    ?? votePair(enclosedHoles, colorShapes, maxWidth);
  const edgeShapes = edgeShapeBlobs(piece);
  const edgePair = votePair([...colorHoles, ...enclosedHoles], edgeShapes, maxWidth);
  return { colorHoles, colorShapes, enclosedHoles, enclosedShapes, colorPair, enclosedPair, edgeShapes, edgePair };
}

export function findGapX(background: RgbaImage, piece: RgbaImage, options: GapOptions = {}): GapResult | null {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const refine = options.refine ?? DEFAULT_REFINE;
  const { width: bgWidth, height: bgHeight } = background;
  const { width: pieceWidth, height: pieceHeight } = piece;
  if (pieceWidth < 4 || pieceHeight < 4 || bgWidth < pieceWidth || bgHeight < pieceHeight) return null;
  if (background.data.length < bgWidth * bgHeight * 4 || piece.data.length < pieceWidth * pieceHeight * 4) return null;

  const maxWidth = bgWidth - pieceWidth;
  const enclosedHoles = enclosedBlobs(background).filter(h => h.area <= MAX_ENCLOSED_HOLE_AREA);
  const colorShapes = [...blobs(piece, nonGreen), ...blobs(piece, brightNeutral)];
  let pair = votePair(enclosedHoles, enclosedBlobs(piece), maxWidth)
    ?? votePair(enclosedHoles, colorShapes, maxWidth);
  let stage: NonNullable<GapResult['stage']> | null = pair ? 'enclosed' : null;
  const colorHoles = pair ? [] : blobs(background, brightNeutral).filter(h => h.area <= MAX_COLOR_HOLE_AREA);
  if (!pair) {
    pair = votePair(colorHoles, colorShapes, maxWidth);
    if (pair) stage = 'color';
  }
  if (!pair && (colorHoles.length || enclosedHoles.length)) {
    pair = votePair([...colorHoles, ...enclosedHoles], edgeShapeBlobs(piece), maxWidth);
    if (pair) stage = 'edges';
  }
  if (pair && stage) {
    const x = Math.round(pair.hole.cx - pair.shape.cx);
    if (x >= 0 && x <= maxWidth) return { x, y: Math.round(pair.hole.cy - pair.shape.cy), score: 0.9, stage };
  }

  const mask = alphaMask(piece);
  const bgLum = luminance(background);
  const pieceLum = luminance(piece);
  const bgMag = sobelMagnitude(bgLum, bgWidth, bgHeight);
  const pieceMag = sobelMagnitude(pieceLum, pieceWidth, pieceHeight);

  const bgColumns = columnProfile(bgMag, bgWidth, bgHeight);
  const pieceColumns = columnProfile(pieceMag, pieceWidth, pieceHeight, mask);
  const shift = bestShift(bgColumns, pieceColumns);
  if (shift < 0) return null;

  let best: GapResult = { x: shift, y: 0, score: -Infinity };
  const fromX = Math.max(0, shift - refine);
  const toX = Math.min(bgWidth - pieceWidth, shift + refine);
  const maxY = bgHeight - pieceHeight;
  for (let x = fromX; x <= toX; x++) {
    for (let y = 0; y <= maxY; y++) {
      const score = ncc2d(bgMag, bgWidth, bgHeight, pieceMag, pieceWidth, pieceHeight, mask, x, y);
      if (score > best.score) best = { x, y, score };
    }
  }
  return best.score >= threshold ? { ...best, stage: 'ncc' } : null;
}
