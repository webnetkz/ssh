(() => {
  if (window.__privacyScannerFpPatched) return;
  window.__privacyScannerFpPatched = true;

  const randomOffset = () => Math.random() * 0.00001;

  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function (...args) {
    try {
      const ctx = this.getContext("2d");
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, this.width, this.height);
        if (imageData.data.length > 4) {
          imageData.data[0] = imageData.data[0] + 1;
          ctx.putImageData(imageData, 0, 0);
        }
      }
    } catch {}
    return originalToDataURL.apply(this, args);
  };

  const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    const UNMASKED_VENDOR_WEBGL = 37445;
    const UNMASKED_RENDERER_WEBGL = 37446;
    if (param === UNMASKED_VENDOR_WEBGL) return "Generic Vendor";
    if (param === UNMASKED_RENDERER_WEBGL) return "Generic Renderer";
    return originalGetParameter.call(this, param);
  };

  const originalAudioGetChannelData = AudioBuffer.prototype.getChannelData;
  AudioBuffer.prototype.getChannelData = function (...args) {
    const data = originalAudioGetChannelData.apply(this, args);
    if (data && data.length) {
      data[0] = data[0] + randomOffset();
    }
    return data;
  };
})();
