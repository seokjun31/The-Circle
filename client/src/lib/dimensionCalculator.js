/**
 * dimensionCalculator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Utility for converting between image pixels and real-world centimetres.
 *
 * Usage
 * ─────
 * 1. User clicks two points on the room image (e.g. two ends of a wall).
 * 2. User enters the real-world distance between those points in cm.
 * 3. Call setReferenceScale(pointA, pointB, realDistanceCm).
 *    This computes pxPerCm and stores it internally.
 * 4. Use pxToCm / cmToPx to convert freely.
 * 5. Use checkFit to determine if furniture fits in an available space.
 *
 * All functions accept/return plain numbers (no React state).
 * Store the calibration object in component state and pass it around.
 */

/**
 * Compute pxPerCm from two reference points and a known distance.
 *
 * @param {{ x: number, y: number }} pointA  First point (image pixels)
 * @param {{ x: number, y: number }} pointB  Second point (image pixels)
 * @param {number} realDistanceCm            Known real-world distance in cm
 * @returns {{ pxPerCm: number, distancePx: number }}
 */
export function setReferenceScale(pointA, pointB, realDistanceCm) {
  if (!realDistanceCm || realDistanceCm <= 0) {
    throw new Error('realDistanceCm must be positive');
  }
  const dx         = pointB.x - pointA.x;
  const dy         = pointB.y - pointA.y;
  const distancePx = Math.sqrt(dx * dx + dy * dy);
  if (distancePx < 1) {
    throw new Error('Reference points are too close together');
  }
  const pxPerCm = distancePx / realDistanceCm;
  return { pxPerCm, distancePx };
}

/**
 * Convert pixels to centimetres using a calibrated scale.
 *
 * @param {number} px          Distance in pixels
 * @param {number} pxPerCm     Calibration value from setReferenceScale
 * @returns {number}           Distance in centimetres
 */
export function pxToCm(px, pxPerCm) {
  if (!pxPerCm || pxPerCm <= 0) return null;
  return px / pxPerCm;
}

/**
 * Convert centimetres to pixels using a calibrated scale.
 *
 * @param {number} cm          Distance in centimetres
 * @param {number} pxPerCm     Calibration value
 * @returns {number}           Distance in pixels
 */
export function cmToPx(cm, pxPerCm) {
  if (!pxPerCm || pxPerCm <= 0) return null;
  return cm * pxPerCm;
}

/**
 * Check whether furniture fits in a given space.
 *
 * @param {number} furnitureWidthCm   Furniture actual width in cm
 * @param {number} spaceWidthCm       Available space width in cm
 * @returns {{
 *   fits:              boolean,
 *   furnitureWidthCm:  number,
 *   spaceWidthCm:      number,
 *   marginCm:          number,
 *   category:          'comfortable' | 'tight' | 'too_large',
 *   borderColor:       string,
 * }}
 */
export function checkFit(furnitureWidthCm, spaceWidthCm) {
  if (furnitureWidthCm == null || spaceWidthCm == null) return null;

  const marginCm = spaceWidthCm - furnitureWidthCm;
  let category, borderColor;

  if (marginCm >= 20) {
    category    = 'comfortable';
    borderColor = '#50fa7b';   // green
  } else if (marginCm >= 0) {
    category    = 'tight';
    borderColor = '#f1fa8c';   // yellow
  } else {
    category    = 'too_large';
    borderColor = '#ff5555';   // red
  }

  return {
    fits:             marginCm >= 0,
    furnitureWidthCm: Math.round(furnitureWidthCm * 10) / 10,
    spaceWidthCm:     Math.round(spaceWidthCm     * 10) / 10,
    marginCm:         Math.round(marginCm          * 10) / 10,
    category,
    borderColor,
  };
}

/**
 * Check fit given a space measured in pixels and a calibration.
 *
 * @param {number} furnitureWidthCm
 * @param {number} spaceWidthPx      Width of the available space in image pixels
 * @param {number} pxPerCm           Calibration from setReferenceScale
 * @returns {ReturnType<checkFit> | null}
 */
export function checkFitFromPx(furnitureWidthCm, spaceWidthPx, pxPerCm) {
  if (!pxPerCm) return null;
  const spaceWidthCm = pxToCm(spaceWidthPx, pxPerCm);
  return checkFit(furnitureWidthCm, spaceWidthCm);
}

/**
 * Human-readable fit result label (Korean).
 *
 * @param {'comfortable' | 'tight' | 'too_large'} category
 * @returns {string}
 */
export function fitCategoryLabel(category) {
  switch (category) {
    case 'comfortable': return '여유 있음';
    case 'tight':       return '빡빡함';
    case 'too_large':   return '들어가지 않음';
    default:            return '—';
  }
}
