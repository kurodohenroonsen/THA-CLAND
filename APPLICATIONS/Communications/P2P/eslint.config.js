/**
 * ESLint 9 Flat Configuration — P2P Mesh Workspace (Standards 2025/2026)
 * Couvre : Extension MV3 (SidePanel, Offscreen, ServiceWorker), PWA WebApp, Web Audio Worklets.
 */

import js from '@eslint/js';
import globals from 'globals';

export default [
  // 1. Dossiers et fichiers ignorés universellement
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.git/**',
      '**/icons/**',
      '**/*.min.js',
      'test/**'
    ]
  },

  // 2. Configuration de base JavaScript ES2022+
  js.configs.recommended,

  // 3. Configuration globale commune pour les modules ES
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module'
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'warn',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'debug', 'info', 'log'] }]
    }
  },

  // 4. Partitionnement Contexte : Side Panel & WebApp Client (DOM + Chrome Shim)
  {
    files: [
      'Extension/sidepanel/js/**/*.js',
      'WebApp/js/**/*.js',
      'Extension/permissions.js',
      'WebApp/permissions.js'
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: 'readonly'
      }
    }
  },

  // 5. Partitionnement Contexte : Background Service Worker (Manifest V3)
  {
    files: ['Extension/background/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        ...globals.webextensions,
        chrome: 'readonly'
      }
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'window indisponible dans un Service Worker.' },
        { name: 'document', message: 'document indisponible dans un Service Worker.' }
      ]
    }
  },

  // 6. Partitionnement Contexte : PWA Service Worker
  {
    files: ['WebApp/sw.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        self: 'readonly',
        caches: 'readonly',
        clients: 'readonly'
      }
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'window indisponible dans un Service Worker PWA.' },
        { name: 'document', message: 'document indisponible dans un Service Worker PWA.' },
        { name: 'chrome', message: 'chrome indisponible dans un Service Worker PWA.' }
      ]
    }
  },

  // 7. Partitionnement Contexte : AudioWorklet Thread
  {
    files: ['**/modules/media/vad-worklet-processor.js'],
    languageOptions: {
      globals: {
        AudioWorkletProcessor: 'readonly',
        registerProcessor: 'readonly',
        currentFrame: 'readonly',
        currentTime: 'readonly',
        sampleRate: 'readonly'
      }
    },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'window indisponible dans AudioWorkletGlobalScope.' },
        { name: 'document', message: 'document indisponible dans AudioWorkletGlobalScope.' },
        { name: 'chrome', message: 'chrome indisponible dans AudioWorkletGlobalScope.' },
        { name: 'setTimeout', message: 'Timers interdits dans la boucle temps réel AudioWorklet.' },
        { name: 'setInterval', message: 'Timers interdits dans la boucle temps réel AudioWorklet.' }
      ]
    }
  },

  // 8. Script d'amorçage classique platform-web.js
  {
    files: ['**/platform-web.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser
      }
    },
    rules: {
      'no-var': 'off'
    }
  }
];
