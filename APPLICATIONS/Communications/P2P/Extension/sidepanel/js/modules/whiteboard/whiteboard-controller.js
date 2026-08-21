/**
 * modules/whiteboard/whiteboard-controller.js
 * Contrôleur de Tableau Blanc Collaboratif (Passe 4)
 */
import { logger } from '../../core/logger.js';

export class WhiteboardController {
  constructor(meshNetwork, crdtEngine, cryptoVault) {
    this.mesh = meshNetwork;
    this.crdt = crdtEngine;
    this.vault = cryptoVault;
    logger.info('Whiteboard', '🎨 Module Tableau Blanc initialisé à la demande.');
  }

  mount() {
    logger.debug('Whiteboard', 'Montage du canvas interactif du Tableau Blanc.');
  }

  destroy() {
    logger.debug('Whiteboard', 'Démontage du canvas et libération des buffers graphiques.');
  }
}
