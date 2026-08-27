// Shared grayscale/color slider control for Leaflet maps.
(function () {
  const STORAGE_KEY = 'adventureLog.mapGrayscale';
  const DEFAULT_VALUE = 60; // 0 = full color, 100 = full grayscale

  function getSavedValue() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_VALUE;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_VALUE;
  }

  function filterFor(value) {
    const amount = value / 100;
    if (amount <= 0) return 'none';
    return `grayscale(${amount}) contrast(${1 + 0.15 * amount}) brightness(${1 - 0.05 * amount})`;
  }

  window.addMapColorControl = function (map) {
    const value = getSavedValue();
    map.getPane('tilePane').style.filter = filterFor(value);

    const Control = L.Control.extend({
      options: { position: 'bottomleft' },
      onAdd: function () {
        const container = L.DomUtil.create('div', 'map-color-control');
        container.innerHTML =
          '<span class="map-color-icon" title="Full color">🎨</span>' +
          '<input type="range" class="map-color-slider" min="0" max="100" step="5" value="' + value + '" title="Map color intensity" />' +
          '<span class="map-color-icon" title="Grayscale">◐</span>';

        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        const slider = container.querySelector('.map-color-slider');
        slider.addEventListener('input', () => {
          map.getPane('tilePane').style.filter = filterFor(slider.value);
          localStorage.setItem(STORAGE_KEY, slider.value);
        });

        return container;
      },
    });

    map.addControl(new Control());
  };
})();
