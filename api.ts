'use strict';

module.exports = {
  async getSoilDiagnostics({ homey }: { homey: { app: { getSoilDiagnostics(): unknown } } }) {
    return homey.app.getSoilDiagnostics();
  },
};
