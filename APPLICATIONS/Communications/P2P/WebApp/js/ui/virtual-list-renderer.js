/**
 * ui/virtual-list-renderer.js
 * VirtualListRenderer — Moteur de Fenêtrage & Virtualisation Ultra-Performant (Vanilla ES2026)
 * Normes : DOM O(1) constant, Dynamic Heights, Binary Search O(log N), 120 FPS Compositing,
 * Zero Layout Thrashing, Double Ancrage (Top-Down & Bottom-Up Chat), WAI-ARIA Feed Pattern.
 */

import { logger } from '../core/logger.js';

export class VirtualListRenderer {
  /**
   * @param {Object} options
   * @param {HTMLElement} options.container - Conteneur défilable (viewport)
   * @param {Array<any>} options.items - Liste des données sources
   * @param {number} [options.estimatedItemHeight=68] - Hauteur moyenne estimée par défaut
   * @param {number} [options.overscan=4] - Nombre d'éléments de pré-rendu hors-champ
   * @param {boolean} [options.isReverse=false] - Mode chat inversé (ancré en bas)
   * @param {Function} options.renderItem - Callback (item, index) => HTMLElement
   * @param {Function} [options.getItemId] - Callback unique (item) => string|number
   */
  constructor(options) {
    if (!options.container || typeof options.renderItem !== 'function') {
      throw new Error('VirtualListRenderer: container et renderItem sont obligatoires.');
    }

    this.container = options.container;
    this.items = options.items || [];
    this.estimatedHeight = options.estimatedItemHeight || 68;
    this.overscan = options.overscan !== undefined ? options.overscan : 4;
    this.isReverse = !!options.isReverse;
    this.renderItemCallback = options.renderItem;
    this.getItemId = options.getItemId || ((item, idx) => item?.id ?? item?.fileId ?? item?.cid ?? idx);

    this.heightCache = new Float64Array(this.items.length);
    this.heightCache.fill(this.estimatedHeight);
    this.offsetCache = new Float64Array(this.items.length + 1);
    this._recomputeOffsets(0);

    this.renderedNodes = new Map();
    this.isTicking = false;
    this.lastScrollTop = 0;
    this.isUserAtBottom = true;

    this._initDOMStructure();
    this._initResizeObserver();
    this._initScrollListener();
  }

  _initDOMStructure() {
    this.container.classList.add('vlist-viewport');
    this.container.style.position = 'relative';
    this.container.style.overflowY = 'auto';
    this.container.style.contain = 'strict';
    this.container.setAttribute('role', 'feed');
    this.container.setAttribute('aria-busy', 'false');

    this.spacer = document.createElement('div');
    this.spacer.className = 'vlist-spacer';
    this.spacer.style.width = '100%';
    this.spacer.style.height = `${this.getTotalHeight()}px`;
    this.spacer.style.pointerEvents = 'none';
    this.spacer.style.position = 'absolute';
    this.spacer.style.top = '0';
    this.spacer.style.left = '0';
    this.spacer.style.zIndex = '-1';

    this.canvas = document.createElement('div');
    this.canvas.className = 'vlist-canvas';
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.right = '0';
    this.canvas.style.willChange = 'transform';

    this.container.innerHTML = '';
    this.container.appendChild(this.spacer);
    this.container.appendChild(this.canvas);
  }

  _initResizeObserver() {
    if (typeof ResizeObserver === 'undefined') return;

    this.resizeObserver = new ResizeObserver((entries) => {
      let hasChanges = false;
      let minChangedIdx = Infinity;

      for (const entry of entries) {
        const el = entry.target;
        const idx = Number(el.dataset.vlistIndex);
        if (isNaN(idx) || idx >= this.items.length) continue;

        const measuredHeight = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
        if (measuredHeight > 0 && Math.abs(this.heightCache[idx] - measuredHeight) > 0.5) {
          this.heightCache[idx] = measuredHeight;
          if (idx < minChangedIdx) minChangedIdx = idx;
          hasChanges = true;
        }
      }

      if (hasChanges) {
        this._recomputeOffsets(minChangedIdx);
        this.spacer.style.height = `${this.getTotalHeight()}px`;
        this.requestRender();
      }
    });
  }

  _initScrollListener() {
    this.scrollHandler = () => {
      const st = this.container.scrollTop;
      const ch = this.container.clientHeight;
      const sh = this.container.scrollHeight;

      this.isUserAtBottom = (sh - st - ch) < 40;
      this.lastScrollTop = st;

      if (!this.isTicking) {
        this.isTicking = true;
        requestAnimationFrame(() => {
          this._renderWindow();
          this.isTicking = false;
        });
      }
    };

    this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
  }

  _recomputeOffsets(startIdx = 0) {
    if (this.offsetCache.length !== this.items.length + 1) {
      this.offsetCache = new Float64Array(this.items.length + 1);
      startIdx = 0;
    }
    for (let i = startIdx; i < this.items.length; i++) {
      this.offsetCache[i + 1] = this.offsetCache[i] + this.heightCache[i];
    }
  }

  _findNearestIndex(targetY) {
    let low = 0;
    let high = this.items.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      const start = this.offsetCache[mid];
      const end = this.offsetCache[mid + 1];

      if (targetY >= start && targetY < end) return mid;
      if (targetY < start) high = mid - 1;
      else low = mid + 1;
    }
    return Math.max(0, Math.min(low, this.items.length - 1));
  }

  _renderWindow() {
    if (this.items.length === 0) {
      this.canvas.innerHTML = '';
      this.spacer.style.height = '0px';
      return;
    }

    const scrollTop = this.container.scrollTop;
    const clientHeight = this.container.clientHeight || 500;

    const startIdx = Math.max(0, this._findNearestIndex(scrollTop) - this.overscan);
    const endIdx = Math.min(this.items.length - 1, this._findNearestIndex(scrollTop + clientHeight) + this.overscan);

    const visibleKeys = new Set();
    const fragment = document.createDocumentFragment();
    const nodesToAdd = [];

    for (let i = startIdx; i <= endIdx; i++) {
      const item = this.items[i];
      const key = String(this.getItemId(item, i));
      visibleKeys.add(key);

      let node = this.renderedNodes.get(key);
      const topOffset = this.offsetCache[i];

      if (!node) {
        node = this.renderItemCallback(item, i);
        node.dataset.vlistKey = key;
        node.dataset.vlistIndex = String(i);
        node.style.position = 'absolute';
        node.style.top = '0';
        node.style.left = '0';
        node.style.width = '100%';
        node.style.transform = `translate3d(0, ${topOffset}px, 0)`;
        node.style.contain = 'content';
        node.style.contentVisibility = 'auto';
        node.style.containIntrinsicSize = `auto ${this.heightCache[i]}px`;
        node.setAttribute('aria-setsize', String(this.items.length));
        node.setAttribute('aria-posinset', String(i + 1));

        this.renderedNodes.set(key, node);
        this.resizeObserver?.observe(node);
        nodesToAdd.push(node);
      } else {
        node.dataset.vlistIndex = String(i);
        node.style.transform = `translate3d(0, ${topOffset}px, 0)`;
      }
    }

    for (const [key, node] of this.renderedNodes.entries()) {
      if (!visibleKeys.has(key)) {
        this.resizeObserver?.unobserve(node);
        node.remove();
        this.renderedNodes.delete(key);
      }
    }

    if (nodesToAdd.length > 0) {
      nodesToAdd.forEach(n => fragment.appendChild(n));
      this.canvas.appendChild(fragment);
    }
  }

  setItems(newItems, maintainPosition = true) {
    const prevScrollTop = this.container.scrollTop;

    this.items = Array.isArray(newItems) ? newItems : [];
    
    const newHeightCache = new Float64Array(this.items.length);
    newHeightCache.fill(this.estimatedHeight);
    const copyLen = Math.min(this.heightCache.length, this.items.length);
    newHeightCache.set(this.heightCache.subarray(0, copyLen));
    this.heightCache = newHeightCache;

    this._recomputeOffsets(0);
    this.spacer.style.height = `${this.getTotalHeight()}px`;

    this._renderWindow();

    if (maintainPosition) {
      if (this.isReverse && this.isUserAtBottom) {
        this.scrollToBottom();
      } else if (this.container.scrollTop !== prevScrollTop) {
        this.container.scrollTop = prevScrollTop;
      }
    }
  }

  appendItems(newItems) {
    if (!newItems || newItems.length === 0) return;
    const oldLength = this.items.length;
    this.items = this.items.concat(newItems);

    const newHeights = new Float64Array(this.items.length);
    newHeights.set(this.heightCache);
    for (let i = oldLength; i < this.items.length; i++) {
      newHeights[i] = this.estimatedHeight;
    }
    this.heightCache = newHeights;

    this._recomputeOffsets(oldLength);
    this.spacer.style.height = `${this.getTotalHeight()}px`;

    this._renderWindow();

    if (this.isReverse && this.isUserAtBottom) {
      this.scrollToBottom();
    }
  }

  prependItems(historicalItems) {
    if (!historicalItems || historicalItems.length === 0) return;
    const addedCount = historicalItems.length;
    const prevScrollTop = this.container.scrollTop;

    this.items = historicalItems.concat(this.items);

    const newHeights = new Float64Array(this.items.length);
    newHeights.fill(this.estimatedHeight, 0, addedCount);
    newHeights.set(this.heightCache, addedCount);
    this.heightCache = newHeights;

    this._recomputeOffsets(0);
    
    const addedHeight = this.offsetCache[addedCount];
    this.spacer.style.height = `${this.getTotalHeight()}px`;

    this.container.scrollTop = prevScrollTop + addedHeight;
    this._renderWindow();
  }

  getTotalHeight() {
    return this.offsetCache[this.items.length] || 0;
  }

  scrollToBottom(smooth = false) {
    const target = this.getTotalHeight() - this.container.clientHeight;
    if (smooth) {
      this.container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    } else {
      this.container.scrollTop = Math.max(0, target);
    }
    this.isUserAtBottom = true;
  }

  requestRender() {
    if (!this.isTicking) {
      this.isTicking = true;
      requestAnimationFrame(() => {
        this._renderWindow();
        this.isTicking = false;
      });
    }
  }

  destroy() {
    this.container.removeEventListener('scroll', this.scrollHandler);
    this.resizeObserver?.disconnect();
    this.renderedNodes.clear();
    this.container.innerHTML = '';
  }
}
