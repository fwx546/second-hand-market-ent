// Only these bundled stock photographs may be used by the seeded demo records.
// User uploads continue to use private R2 media and cannot select these paths.
export const DEMO_OWNER_ID = 'juzi_demo_catalog';
export const DEMO_CATALOG = Object.freeze({
  demo_juzi_01: '/assets/fan.jpg',
  demo_juzi_02: '/assets/kettle.jpg',
  demo_juzi_03: '/assets/hairdryer.jpg',
  demo_juzi_04: '/assets/headphones.jpg',
  demo_juzi_05: '/assets/speaker.jpg',
  demo_juzi_06: '/assets/lamp.jpg',
  demo_juzi_07: '/assets/scooter-1.jpg',
  demo_juzi_08: '/assets/scooter-2.jpg',
  demo_juzi_09: '/assets/scooter-3.jpg',
  demo_juzi_10: '/assets/scooter-4.jpg',
  demo_juzi_11: '/assets/scooter-5.jpg',
  demo_juzi_12: '/assets/scooter-6.jpg',
  demo_juzi_13: '/assets/mug.jpg',
  demo_juzi_14: '/assets/yoga.jpg',
  demo_juzi_15: '/assets/plant.jpg',
  demo_juzi_16: '/assets/umbrella.jpg',
  demo_juzi_17: '/assets/chair.jpg',
  demo_juzi_18: '/assets/mug.jpg',
});

export function demoImages(productId) {
  return Object.hasOwn(DEMO_CATALOG, productId) ? [DEMO_CATALOG[productId]] : [];
}
