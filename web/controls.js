/**
 * VJ Touch Controls for iPad 10 / Mobile Touchscreens
 * Specification: docs/CONTROL.md
 * Provides Pointer Events-based Fader, XYPad, MomentaryButton, and LatchingButton
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VJControls = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Registry of active momentary buttons for safety release on blur / visibilitychange
  const activeMomentaries = new Set();

  function releaseAllMomentary() {
    for (const btn of activeMomentaries) {
      btn.release();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('blur', releaseAllMomentary);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        releaseAllMomentary();
      }
    });
  }

  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }

  /**
   * Relative Fader
   * Follows finger movement relative to touch point (does not jump on tap).
   * Double-tap resets to default value.
   */
  class Fader {
    constructor(container, options = {}) {
      this.container = container;
      this.orientation = options.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      this.min = typeof options.min === 'number' ? options.min : 0;
      this.max = typeof options.max === 'number' ? options.max : 1;
      this.step = typeof options.step === 'number' ? options.step : 0;
      this.defaultVal = typeof options.default === 'number' ? options.default : this.min;
      this.val = typeof options.value === 'number' ? options.value : this.defaultVal;
      this.sensitivity = typeof options.sensitivity === 'number' ? options.sensitivity : 1.0;
      this.label = options.label || '';
      this.unit = options.unit || '';
      this.format = typeof options.format === 'function' ? options.format : (v => {
        if (this.step >= 1) return Math.round(v).toString();
        if (this.max - this.min <= 3) return v.toFixed(2);
        return v.toFixed(1);
      });

      this.onInput = typeof options.onInput === 'function' ? options.onInput : () => {};
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

      this.activePointerId = null;
      this.startPos = 0;
      this.startVal = this.val;
      this.isInteracting = false;
      this.lastTapTime = 0;

      this.render();
      this.bindEvents();
      this.updateUI();
    }

    render() {
      this.container.classList.add('vj-fader', `vj-fader-${this.orientation}`);
      this.container.style.touchAction = 'none';
      this.container.style.userSelect = 'none';
      this.container.style.webkitUserSelect = 'none';

      this.container.innerHTML = `
        <div class="vj-fader-track">
          <div class="vj-fader-fill"></div>
          <div class="vj-fader-thumb"></div>
        </div>
      `;

      this.track = this.container.querySelector('.vj-fader-track');
      this.fill = this.container.querySelector('.vj-fader-fill');
      this.thumb = this.container.querySelector('.vj-fader-thumb');
    }

    bindEvents() {
      this.container.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const now = performance.now();
        if (now - this.lastTapTime < 320) {
          // Double-tap detected: reset to default value
          this.lastTapTime = 0;
          this.setValue(this.defaultVal, true);
          this.onChange(this.val);
          return;
        }
        this.lastTapTime = now;

        if (this.activePointerId !== null) return;

        this.activePointerId = e.pointerId;
        this.container.setPointerCapture(e.pointerId);
        this.isInteracting = true;
        this.container.classList.add('active');

        this.startPos = this.orientation === 'vertical' ? e.clientY : e.clientX;
        this.startVal = this.val;
      });

      this.container.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.activePointerId) return;
        e.preventDefault();

        const rect = this.track.getBoundingClientRect();
        const length = this.orientation === 'vertical' ? rect.height : rect.width;
        if (length <= 0) return;

        // Relative delta: for vertical, dragging UP increases value
        const deltaPixels = this.orientation === 'vertical'
          ? (this.startPos - e.clientY)
          : (e.clientX - this.startPos);

        const fraction = (deltaPixels / length) * this.sensitivity;
        let nextVal = this.startVal + fraction * (this.max - this.min);
        nextVal = clamp(nextVal, this.min, this.max);

        if (this.step > 0) {
          nextVal = Math.round((nextVal - this.min) / this.step) * this.step + this.min;
          nextVal = clamp(nextVal, this.min, this.max);
        }

        this.val = nextVal;
        this.updateUI();
        this.onInput(this.val);
      });

      const onPointerEnd = (e) => {
        if (e.pointerId !== this.activePointerId) return;
        this.activePointerId = null;
        this.isInteracting = false;
        this.container.classList.remove('active');
        try {
          this.container.releasePointerCapture(e.pointerId);
        } catch (err) {}

        this.onChange(this.val);
      };

      this.container.addEventListener('pointerup', onPointerEnd);
      this.container.addEventListener('pointercancel', onPointerEnd);
    }

    setValue(newVal, force = false) {
      if (this.isInteracting && !force) return;
      let clamped = clamp(newVal, this.min, this.max);
      if (this.step > 0) {
        clamped = Math.round((clamped - this.min) / this.step) * this.step + this.min;
      }
      this.val = clamped;
      this.updateUI();
    }

    updateUI() {
      const range = this.max - this.min || 1;
      const pct = clamp((this.val - this.min) / range, 0, 1) * 100;

      if (this.orientation === 'vertical') {
        this.fill.style.height = `${pct}%`;
        this.thumb.style.bottom = `${pct}%`;
      } else {
        this.fill.style.width = `${pct}%`;
        this.thumb.style.left = `${pct}%`;
      }
    }
  }

  /**
   * XY Pad
   * Controls 2 bipolar or unipolar parameters simultaneously.
   * Optional spring-back on release.
   */
  class XYPad {
    constructor(container, options = {}) {
      this.container = container;
      this.minX = typeof options.minX === 'number' ? options.minX : -1;
      this.maxX = typeof options.maxX === 'number' ? options.maxX : 1;
      this.defaultX = typeof options.defaultX === 'number' ? options.defaultX : 0;
      this.x = typeof options.x === 'number' ? options.x : this.defaultX;

      this.minY = typeof options.minY === 'number' ? options.minY : -1;
      this.maxY = typeof options.maxY === 'number' ? options.maxY : 1;
      this.defaultY = typeof options.defaultY === 'number' ? options.defaultY : 0;
      this.y = typeof options.y === 'number' ? options.y : this.defaultY;

      this.spring = options.spring !== false; // default true
      this.labelX = options.labelX || 'X';
      this.labelY = options.labelY || 'Y';

      this.onInput = typeof options.onInput === 'function' ? options.onInput : () => {};
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

      this.activePointerId = null;
      this.isInteracting = false;
      this.startClientX = 0;
      this.startClientY = 0;
      this.startValX = this.x;
      this.startValY = this.y;

      this.render();
      this.bindEvents();
      this.updateUI();
    }

    render() {
      this.container.classList.add('vj-xypad');
      this.container.style.touchAction = 'none';
      this.container.style.userSelect = 'none';
      this.container.style.webkitUserSelect = 'none';

      this.container.innerHTML = `
        <div class="vj-xypad-surface">
          <div class="vj-xypad-crosshair-x"></div>
          <div class="vj-xypad-crosshair-y"></div>
          <div class="vj-xypad-puck"></div>
          <div class="vj-xypad-labels">
            <span class="vj-xypad-lbl-x">${this.labelX}</span>
            <span class="vj-xypad-lbl-y">${this.labelY}</span>
          </div>
        </div>
      `;

      this.surface = this.container.querySelector('.vj-xypad-surface');
      this.puck = this.container.querySelector('.vj-xypad-puck');
      this.crosshairX = this.container.querySelector('.vj-xypad-crosshair-x');
      this.crosshairY = this.container.querySelector('.vj-xypad-crosshair-y');
    }

    bindEvents() {
      this.surface.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.activePointerId !== null) return;

        this.activePointerId = e.pointerId;
        this.surface.setPointerCapture(e.pointerId);
        this.isInteracting = true;
        this.container.classList.add('active');

        this.startClientX = e.clientX;
        this.startClientY = e.clientY;
        this.startValX = this.x;
        this.startValY = this.y;
      });

      this.surface.addEventListener('pointermove', (e) => {
        if (e.pointerId !== this.activePointerId) return;
        e.preventDefault();

        const rect = this.surface.getBoundingClientRect();
        const halfW = rect.width / 2 || 1;
        const halfH = rect.height / 2 || 1;

        const deltaX = (e.clientX - this.startClientX) / halfW;
        // Invert Y so up is positive
        const deltaY = (this.startClientY - e.clientY) / halfH;

        const spanX = (this.maxX - this.minX) / 2;
        const spanY = (this.maxY - this.minY) / 2;

        this.x = clamp(this.startValX + deltaX * spanX, this.minX, this.maxX);
        this.y = clamp(this.startValY + deltaY * spanY, this.minY, this.maxY);

        this.updateUI();
        this.onInput(this.x, this.y);
      });

      const onPointerEnd = (e) => {
        if (e.pointerId !== this.activePointerId) return;
        this.activePointerId = null;
        this.isInteracting = false;
        this.container.classList.remove('active');
        try {
          this.surface.releasePointerCapture(e.pointerId);
        } catch (err) {}

        if (this.spring) {
          this.x = this.defaultX;
          this.y = this.defaultY;
          this.updateUI();
          this.onInput(this.x, this.y);
          this.onChange(this.x, this.y);
        } else {
          this.onChange(this.x, this.y);
        }
      };

      this.surface.addEventListener('pointerup', onPointerEnd);
      this.surface.addEventListener('pointercancel', onPointerEnd);
    }

    setValues(x, y, force = false) {
      if (this.isInteracting && !force) return;
      this.x = clamp(x, this.minX, this.maxX);
      this.y = clamp(y, this.minY, this.maxY);
      this.updateUI();
    }

    updateUI() {
      const rangeX = this.maxX - this.minX || 1;
      const rangeY = this.maxY - this.minY || 1;

      const pctX = clamp((this.x - this.minX) / rangeX, 0, 1) * 100;
      // Y: min is bottom (0%), max is top (100%)
      const pctY = clamp((this.y - this.minY) / rangeY, 0, 1) * 100;

      this.puck.style.left = `${pctX}%`;
      this.puck.style.bottom = `${pctY}%`;

      if (this.crosshairX) this.crosshairX.style.bottom = `${pctY}%`;
      if (this.crosshairY) this.crosshairY.style.left = `${pctX}%`;
    }
  }

  /**
   * Momentary Button (Taster)
   * Sends 1 on press, 0 on release.
   * Sends 0 on pointercancel, window blur, and document visibilitychange.
   */
  class MomentaryButton {
    constructor(element, options = {}) {
      this.element = element;
      this.onTrigger = typeof options.onTrigger === 'function' ? options.onTrigger : () => {};
      this.activePointerId = null;
      this.isPressed = false;

      this.element.style.touchAction = 'none';
      this.element.style.userSelect = 'none';
      this.element.style.webkitUserSelect = 'none';

      this.bindEvents();
    }

    bindEvents() {
      this.element.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.activePointerId !== null) return;

        this.activePointerId = e.pointerId;
        this.element.setPointerCapture(e.pointerId);
        this.press();
      });

      const onPointerEnd = (e) => {
        if (e.pointerId !== this.activePointerId) return;
        this.activePointerId = null;
        try {
          this.element.releasePointerCapture(e.pointerId);
        } catch (err) {}
        this.release();
      };

      this.element.addEventListener('pointerup', onPointerEnd);
      this.element.addEventListener('pointercancel', onPointerEnd);
    }

    press() {
      if (this.isPressed) return;
      this.isPressed = true;
      activeMomentaries.add(this);
      this.element.classList.add('is-pressed');
      this.onTrigger(1);
    }

    release() {
      if (!this.isPressed) return;
      this.isPressed = false;
      this.activePointerId = null;
      activeMomentaries.delete(this);
      this.element.classList.remove('is-pressed');
      this.onTrigger(0);
    }
  }

  /**
   * Latching Button (Rasttaste / Toggle)
   */
  class LatchingButton {
    constructor(element, options = {}) {
      this.element = element;
      this.active = !!options.active;
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

      this.element.style.touchAction = 'manipulation';
      this.element.style.userSelect = 'none';
      this.element.style.webkitUserSelect = 'none';

      this.updateUI();
      this.bindEvents();
    }

    bindEvents() {
      this.element.addEventListener('click', (e) => {
        e.preventDefault();
        this.toggle();
      });
    }

    toggle() {
      this.setActive(!this.active);
      this.onChange(this.active);
    }

    setActive(active) {
      this.active = !!active;
      this.updateUI();
    }

    updateUI() {
      if (this.active) {
        this.element.classList.add('is-active');
      } else {
        this.element.classList.remove('is-active');
      }
    }
  }

  return {
    Fader,
    XYPad,
    MomentaryButton,
    LatchingButton,
    createFader: (container, options) => new Fader(container, options),
    createXYPad: (container, options) => new XYPad(container, options),
    createMomentaryButton: (el, options) => new MomentaryButton(el, options),
    createLatchingButton: (el, options) => new LatchingButton(el, options)
  };
});
