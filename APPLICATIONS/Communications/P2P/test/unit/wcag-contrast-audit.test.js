/**
 * test/unit/wcag-contrast-audit.test.js
 * Suite de Tests d'Audit Adversarial & Calcul Mathématique WCAG 2.2 AAA
 * Runner: Node.js Native Test Runner (node:test & node:assert/strict)
 * Zéro Dépendance — Formule Normative W3C sRGB Relative Luminance & Alpha Blending
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Utilitaires Mathématiques de Colorimétrie WCAG 2.2
 */
class WcagColorMath {
  /**
   * Convertit un code hexadécimal (#rgb, #rrggbb) en tuple [r, g, b] normalisé 0..255
   */
  static parseHex(hex) {
    let clean = hex.replace('#', '').trim();
    if (clean.length === 3) {
      clean = clean.split('').map(c => c + c).join('');
    }
    const num = parseInt(clean, 16);
    return [
      (num >> 16) & 255,
      (num >> 8) & 255,
      num & 255
    ];
  }

  /**
   * Convertit une chaîne rgba(r, g, b, a) en objet { r, g, b, a }
   */
  static parseRgba(rgbaStr) {
    const match = rgbaStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!match) throw new Error(`Format RGBA invalide: ${rgbaStr}`);
    return {
      r: parseInt(match[1], 10),
      g: parseInt(match[2], 10),
      b: parseInt(match[3], 10),
      a: match[4] !== undefined ? parseFloat(match[4]) : 1.0
    };
  }

  /**
   * Effectue le mélange alpha (Alpha Blending) d'une couleur semi-transparente sur un fond opaque
   */
  static alphaComposite(fgRgba, bgHex) {
    const [bgR, bgG, bgB] = WcagColorMath.parseHex(bgHex);
    const a = fgRgba.a;
    return [
      Math.round(fgRgba.r * a + bgR * (1 - a)),
      Math.round(fgRgba.g * a + bgG * (1 - a)),
      Math.round(fgRgba.b * a + bgB * (1 - a))
    ];
  }

  /**
   * Calcule la luminance relative standard W3C WCAG 2.2 d'un tuple RGB [0..255]
   */
  static relativeLuminance([r, g, b]) {
    const [rLin, gLin, bLin] = [r, g, b].map(val => {
      const s = val / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
  }

  /**
   * Calcule le ratio de contraste strict W3C entre deux couleurs
   */
  static contrastRatio(rgb1, rgb2) {
    const l1 = WcagColorMath.relativeLuminance(rgb1);
    const l2 = WcagColorMath.relativeLuminance(rgb2);
    const brighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (brighter + 0.05) / (darker + 0.05);
  }
}

describe('👁️ WCAG 2.2 AAA — Audit des Ratios de Contraste', () => {

  // Palette Thème Sombre Calibrée AAA
  const REMEDIATED_DARK_TOKENS = {
    bgPrimary: '#080b11',
    bgSecondary: '#0f1422',
    bgTertiary: '#161e31',
    textPrimary: '#ffffff',
    textSecondary: '#cbd5e1', // L=0.651 -> Ratio > 10:1
    textMuted: '#a6b4c9',     // L=0.461 -> Ratio > 8.0:1 (AAA >= 7:1)
    textHighlight: '#7dd3fc', // L=0.608 -> Ratio > 10.3:1
    accentCyanText: '#22d3ee', // L=0.584 -> Ratio > 9.9:1
    accentEmeraldText: '#34d399', // L=0.548 -> Ratio > 9.3:1
    accentAmberText: '#fbbf24',   // L=0.597 -> Ratio > 10.1:1
    accentRoseText: '#fda4af'     // L=0.512 -> Ratio > 8.0:1
  };

  // Palette Thème Clair Calibrée AAA
  const LIGHT_TOKENS = {
    bgPrimary: '#ffffff',
    bgSecondary: '#f1f5f9',
    bgTertiary: '#e2e8f0',
    textPrimary: '#0f172a',
    textSecondary: '#334155',
    textMuted: '#334155',
    textHighlight: '#0c4a6e',
    accentCyan: '#164e63',
    accentEmerald: '#064e3b',
    accentAmber: '#713f12',
    accentRose: '#881337'
  };

  describe('1. Validation Mathématique de la Palette Sombre AAA', () => {

    test('Tous les tokens de texte dépassent le seuil strict AAA (7.0:1) sur toutes les surfaces sombres', () => {
      const backgrounds = [
        REMEDIATED_DARK_TOKENS.bgPrimary,
        REMEDIATED_DARK_TOKENS.bgSecondary,
        REMEDIATED_DARK_TOKENS.bgTertiary
      ];

      const textTokens = [
        { name: 'textPrimary', hex: REMEDIATED_DARK_TOKENS.textPrimary },
        { name: 'textSecondary', hex: REMEDIATED_DARK_TOKENS.textSecondary },
        { name: 'textMuted', hex: REMEDIATED_DARK_TOKENS.textMuted },
        { name: 'textHighlight', hex: REMEDIATED_DARK_TOKENS.textHighlight },
        { name: 'accentCyanText', hex: REMEDIATED_DARK_TOKENS.accentCyanText },
        { name: 'accentEmeraldText', hex: REMEDIATED_DARK_TOKENS.accentEmeraldText },
        { name: 'accentAmberText', hex: REMEDIATED_DARK_TOKENS.accentAmberText },
        { name: 'accentRoseText', hex: REMEDIATED_DARK_TOKENS.accentRoseText }
      ];

      for (const bgHex of backgrounds) {
        const bgRgb = WcagColorMath.parseHex(bgHex);
        for (const token of textTokens) {
          const textRgb = WcagColorMath.parseHex(token.hex);
          const ratio = WcagColorMath.contrastRatio(textRgb, bgRgb);
          assert.ok(
            ratio >= 7.0,
            `ÉCHEC AAA : ${token.name} (${token.hex}) sur fond ${bgHex} a un ratio de ${ratio.toFixed(2)}:1 (< 7.0:1)`
          );
        }
      }
    });

    test('.btn-primary avec texte sombre profond garantit la conformité AAA sur cyan', () => {
      const darkText = WcagColorMath.parseHex('#041017');
      const cyanBg = WcagColorMath.parseHex('#06b6d4');
      const ratio = WcagColorMath.contrastRatio(darkText, cyanBg);
      assert.ok(ratio >= 7.0, `Le bouton principal remédié (${ratio.toFixed(2)}:1) doit être >= 7.0:1`);
    });
  });

  describe('2. Validation Mathématique du Thème Clair AAA', () => {

    test('Tous les tokens du thème clair dépassent le seuil strict AAA (7.0:1) sur toutes les surfaces claires', () => {
      const lightBgs = [
        LIGHT_TOKENS.bgPrimary,
        LIGHT_TOKENS.bgSecondary,
        LIGHT_TOKENS.bgTertiary
      ];

      const lightTexts = [
        { name: 'textPrimary', hex: LIGHT_TOKENS.textPrimary },
        { name: 'textSecondary', hex: LIGHT_TOKENS.textSecondary },
        { name: 'textMuted', hex: LIGHT_TOKENS.textMuted },
        { name: 'textHighlight', hex: LIGHT_TOKENS.textHighlight },
        { name: 'accentCyan', hex: LIGHT_TOKENS.accentCyan },
        { name: 'accentEmerald', hex: LIGHT_TOKENS.accentEmerald },
        { name: 'accentAmber', hex: LIGHT_TOKENS.accentAmber },
        { name: 'accentRose', hex: LIGHT_TOKENS.accentRose }
      ];

      for (const bgHex of lightBgs) {
        const bgRgb = WcagColorMath.parseHex(bgHex);
        for (const token of lightTexts) {
          const textRgb = WcagColorMath.parseHex(token.hex);
          const ratio = WcagColorMath.contrastRatio(textRgb, bgRgb);
          assert.ok(
            ratio >= 7.0,
            `ÉCHEC THÈME CLAIR AAA : ${token.name} (${token.hex}) sur fond ${bgHex} a un ratio de ${ratio.toFixed(2)}:1 (< 7.0:1)`
          );
        }
      }
    });
  });
});
