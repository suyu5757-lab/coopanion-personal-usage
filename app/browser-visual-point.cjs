'use strict';

/** Maps pixels from a resized screenshot into the page's CSS viewport. */
function imagePointToViewport(capture, point) {
  const imageWidth = Number(capture?.imageWidth);
  const imageHeight = Number(capture?.imageHeight);
  const viewportWidth = Number(capture?.viewportWidth);
  const viewportHeight = Number(capture?.viewportHeight);
  const x = Number(point?.x), y = Number(point?.y);
  if (![imageWidth, imageHeight, viewportWidth, viewportHeight, x, y].every(Number.isFinite)
    || imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0 || viewportHeight <= 0
    || x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return null;
  return { x: x * viewportWidth / imageWidth, y: y * viewportHeight / imageHeight };
}

module.exports = { imagePointToViewport };
