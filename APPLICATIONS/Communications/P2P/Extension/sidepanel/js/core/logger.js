/**
 * Module Central de Journalisation & Télémétrie Sécurisée — P2P Mesh Workspace
 * Niveaux de sévérité, filtrage par sous-système, buffer circulaire en mémoire,
 * masquage automatique des secrets et export de diagnostic anonymisé.
 */

export const LogLevel = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const LOG_LEVEL_NAMES = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR'
};

const TAG_COLORS = {
  App: '#06b6d4',
  'P2P Mesh': '#8b5cf6',
  Presence: '#10b981',
  CRDT: '#f59e0b',
  Drive: '#38bdf8',
  Chat: '#ec4899',
  Forum: '#a855f7',
  Media: '#f43f5e',
  Auth: '#14b8a6',
  Vault: '#6366f1',
  Storage: '#eab308'
};

class LoggerService {
  constructor() {
    this.bufferCapacity = 1000;
    this.buffer = [];
    this.globalHandlersInstalled = false;
  }

  /**
   * Détermine le niveau minimal de log actif.
   * Par défaut INFO (1), configurable via localStorage['pmesh.loglevel'].
   */
  get currentLogLevel() {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('pmesh.loglevel');
        if (stored) {
          const upper = stored.toUpperCase();
          if (upper in LogLevel) return LogLevel[upper];
          const num = parseInt(stored, 10);
          if (!isNaN(num) && num >= 0 && num <= 3) return num;
        }
      }
    } catch {}
    return LogLevel.INFO;
  }

  /**
   * Vérifie si le mode DEBUG est activé pour un tag donné.
   * Configurable via localStorage['pmesh.debug'] (ex: 'true', '*', 'crdt,drive').
   */
  isDebugEnabledFor(tag = '') {
    try {
      if (typeof localStorage !== 'undefined') {
        const flag = localStorage.getItem('pmesh.debug');
        if (!flag) return false;
        if (flag === 'true' || flag === '1' || flag === '*') return true;
        const activeTags = flag.toLowerCase().split(',').map(s => s.trim());
        const cleanTag = tag.toLowerCase().replace(/[^a-z0-9]/g, '');
        return activeTags.some(t => cleanTag.includes(t.replace(/[^a-z0-9]/g, '')));
      }
    } catch {}
    return false;
  }

  /**
   * Masque les secrets (codes papier, clés brutes, secrets) avant affichage/stockage.
   */
  sanitize(arg) {
    if (arg === null || arg === undefined) return arg;
    if (typeof arg === 'string') {
      let sanitized = arg;
      // Masque les codes papier au format MOT-MOT-MOT-... (ex: ALPHA-BRAVO-CHARLIE -> ALPHA-***)
      sanitized = sanitized.replace(/\b([A-Z]{3,15})-([A-Z0-9-]{10,80})\b/gi, '$1-***REDACTED***');
      // Masque les clés hexadécimales brutes de 64 caractères (clés privées / master keys)
      sanitized = sanitized.replace(/\b[0-9a-fA-F]{64}\b/g, (match) => `${match.substring(0, 8)}...[KEY_REDACTED]`);
      return sanitized;
    }
    if (arg instanceof Error) {
      return {
        name: arg.name,
        message: this.sanitize(arg.message),
        stack: this.sanitize(arg.stack)
      };
    }
    if (typeof arg === 'object') {
      try {
        const copy = Array.isArray(arg) ? [] : {};
        for (const [k, v] of Object.entries(arg)) {
          const lowerK = k.toLowerCase();
          if (lowerK.includes('papercode') || lowerK.includes('masterkey') || lowerK.includes('secretkey') || lowerK.includes('privatekey')) {
            copy[k] = '***REDACTED***';
          } else if (typeof v === 'string') {
            copy[k] = this.sanitize(v);
          } else if (typeof v === 'object' && v !== null) {
            copy[k] = this.sanitize(v);
          } else {
            copy[k] = v;
          }
        }
        return copy;
      } catch {
        return '[Object non sérialisable]';
      }
    }
    return arg;
  }

  _formatTime(date = new Date()) {
    const pad = (n, z = 2) => String(n).padStart(z, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  _pushToBuffer(level, tag, message, args) {
    const entry = {
      timestamp: Date.now(),
      timeStr: this._formatTime(),
      level,
      levelName: LOG_LEVEL_NAMES[level] || 'LOG',
      tag,
      message: typeof message === 'string' ? this.sanitize(message) : this.sanitize(JSON.stringify(message)),
      data: args.length > 0 ? args.map(a => this.sanitize(a)) : undefined
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.bufferCapacity) {
      this.buffer.shift();
    }
  }

  _shouldLog(level, tag) {
    if (level === LogLevel.DEBUG) {
      return this.currentLogLevel === LogLevel.DEBUG || this.isDebugEnabledFor(tag);
    }
    return level >= this.currentLogLevel;
  }

  debug(tag, message, ...args) {
    this._pushToBuffer(LogLevel.DEBUG, tag, message, args);
    if (!this._shouldLog(LogLevel.DEBUG, tag)) return;

    const time = this._formatTime();
    const color = TAG_COLORS[tag] || '#94a3b8';
    console.debug(
      `%c[${time}]%c [${tag}]%c ${this.sanitize(message)}`,
      'color: #64748b; font-size: 11px;',
      `color: ${color}; font-weight: bold;`,
      'color: inherit;',
      ...args.map(a => this.sanitize(a))
    );
  }

  info(tag, message, ...args) {
    this._pushToBuffer(LogLevel.INFO, tag, message, args);
    if (!this._shouldLog(LogLevel.INFO, tag)) return;

    const time = this._formatTime();
    const color = TAG_COLORS[tag] || '#38bdf8';
    console.log(
      `%c[${time}]%c [${tag}]%c ${this.sanitize(message)}`,
      'color: #64748b; font-size: 11px;',
      `color: ${color}; font-weight: bold;`,
      'color: inherit;',
      ...args.map(a => this.sanitize(a))
    );
  }

  warn(tag, message, ...args) {
    this._pushToBuffer(LogLevel.WARN, tag, message, args);
    if (!this._shouldLog(LogLevel.WARN, tag)) return;

    const time = this._formatTime();
    console.warn(
      `%c[${time}]%c [${tag}]%c ⚠️ ${this.sanitize(message)}`,
      'color: #64748b; font-size: 11px;',
      'color: #f59e0b; font-weight: bold;',
      'color: inherit;',
      ...args.map(a => this.sanitize(a))
    );
  }

  error(tag, message, ...args) {
    this._pushToBuffer(LogLevel.ERROR, tag, message, args);
    if (!this._shouldLog(LogLevel.ERROR, tag)) return;

    const time = this._formatTime();
    console.error(
      `%c[${time}]%c [${tag}]%c ❌ ${this.sanitize(message)}`,
      'color: #64748b; font-size: 11px;',
      'color: #f43f5e; font-weight: bold;',
      'color: inherit;',
      ...args.map(a => this.sanitize(a))
    );
  }

  /**
   * Crée un sous-logger lié à un tag fixe pour éviter la répétition du tag.
   */
  child(tag) {
    return {
      debug: (msg, ...args) => this.debug(tag, msg, ...args),
      info: (msg, ...args) => this.info(tag, msg, ...args),
      warn: (msg, ...args) => this.warn(tag, msg, ...args),
      error: (msg, ...args) => this.error(tag, msg, ...args)
    };
  }

  /**
   * Retourne l'ensemble des entrées du buffer circulaire.
   */
  getRecentLogs(limit = 200) {
    return this.buffer.slice(-limit);
  }

  /**
   * Efface le buffer circulaire.
   */
  clearBuffer() {
    this.buffer = [];
  }

  /**
   * Installe les gestionnaires globaux d'erreurs non interceptées.
   */
  installGlobalHandlers() {
    if (this.globalHandlersInstalled) return;
    if (typeof window === 'undefined') return;

    window.addEventListener('error', (event) => {
      this.error(
        'App',
        `Exception non interceptée: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
        event.error ? { stack: event.error.stack } : undefined
      );
    });

    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      this.error(
        'App',
        `Promesse rejetée non gérée: ${reason?.message || reason}`,
        reason?.stack ? { stack: reason.stack } : undefined
      );
    });

    this.globalHandlersInstalled = true;
    this.debug('App', 'Gestionnaires globaux d\'erreurs installés (window.onerror, unhandledrejection).');
  }

  /**
   * Génère un export complet de diagnostic anonymisé.
   */
  async exportDiagnostic(context = {}) {
    let storageEstimate = null;
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        storageEstimate = {
          usageBytes: est.usage,
          quotaBytes: est.quota,
          percent: est.quota ? Math.round((est.usage / est.quota) * 100) : null
        };
      }
    } catch {}

    const diagnosticData = {
      exportedAt: new Date().toISOString(),
      environment: {
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js',
        platform: typeof navigator !== 'undefined' ? navigator.platform : 'Unknown',
        isSecureContext: typeof window !== 'undefined' ? Boolean(window.isSecureContext) : true,
        online: typeof navigator !== 'undefined' ? navigator.onLine : true,
        storage: storageEstimate
      },
      p2pState: {
        topicTruncated: context.topicHex ? `${context.topicHex.substring(0, 10)}...` : null,
        peerIdTruncated: context.peerId ? `${context.peerId.substring(0, 10)}...` : null,
        connectedPeersCount: context.connectedPeersCount || 0,
        rosterCount: context.rosterCount || 0,
        activeChannel: context.activeChannel || 'general'
      },
      loggingConfig: {
        logLevel: LOG_LEVEL_NAMES[this.currentLogLevel],
        debugFilter: (typeof localStorage !== 'undefined' ? localStorage.getItem('pmesh.debug') : null) || 'none',
        totalBufferEntries: this.buffer.length
      },
      recentLogs: this.getRecentLogs(300)
    };

    return diagnosticData;
  }
}

export const logger = new LoggerService();
