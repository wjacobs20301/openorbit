/** Small SVG images used as map markers, as data URLs. */

const svg = (body: string, w: number, h: number) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`,
  )}`;

/** The street view person: yellow, standing, feet at the bottom centre. */
export const PERSON_ICON = svg(
  `<g stroke="#5a3d00" stroke-width="1.5" stroke-linejoin="round">
     <circle cx="14" cy="7.5" r="5.5" fill="#ffc21a"/>
     <path d="M7 15.5 Q14 12.5 21 15.5 L22.5 27 L18.5 27.5 L18 37.5 L10 37.5 L9.5 27.5 L5.5 27 Z" fill="#ffc21a"/>
   </g>`,
  28,
  40,
);

/** Field-of-view wedge pointing up (north before rotation), centred on the image. */
export const VIEW_CONE = svg(
  `<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">
     <stop offset="0" stop-color="#2f7dff" stop-opacity="0.95"/>
     <stop offset="1" stop-color="#2f7dff" stop-opacity="0.45"/>
   </radialGradient></defs>
   <path d="M50 50 L26 5 A50 50 0 0 1 74 5 Z" fill="url(#g)" stroke="#ffffff" stroke-width="2"/>`,
  100,
  100,
);

/** Placemark icons to choose from in the Properties window, drawn in the place's colour. */
export const PLACEMARK_ICONS = ['dot', 'pushpin', 'pin', 'star', 'square', 'triangle', 'flag', 'home', 'camera'] as const;
export type PlacemarkIcon = (typeof PLACEMARK_ICONS)[number];

/** Icons whose point is at the bottom rather than the centre. */
export const BOTTOM_ANCHORED: readonly PlacemarkIcon[] = ['pushpin', 'pin', 'flag'];

export function placemarkIcon(icon: PlacemarkIcon, color: string): string {
  const fill = `fill="${color}" stroke="#000" stroke-opacity="0.7" stroke-width="1.5" stroke-linejoin="round"`;
  const shapes: Record<PlacemarkIcon, string> = {
    dot: `<circle cx="16" cy="16" r="7" ${fill}/>`,
    pushpin: `<circle cx="18" cy="9" r="6.5" ${fill}/><path d="M16 15 L9 30" stroke="#333" stroke-width="2" stroke-linecap="round"/>`,
    pin: `<path d="M16 31 C10 22 6 18 6 12 a10 10 0 0 1 20 0 c0 6 -4 10 -10 19z" ${fill}/><circle cx="16" cy="12" r="3.5" fill="#fff" fill-opacity="0.85"/>`,
    star: `<path d="M16 3 L19.8 11.8 L29 12.6 L22 18.8 L24.1 28 L16 23.2 L7.9 28 L10 18.8 L3 12.6 L12.2 11.8 Z" ${fill}/>`,
    square: `<rect x="7" y="7" width="18" height="18" rx="2" ${fill}/>`,
    triangle: `<path d="M16 5 L28 26 L4 26 Z" ${fill}/>`,
    flag: `<path d="M8 30 V4" stroke="#333" stroke-width="2" stroke-linecap="round"/><path d="M9 5 H26 L22 10.5 L26 16 H9 Z" ${fill}/>`,
    home: `<path d="M5 16 L16 6 L27 16 H24 V27 H8 V16 Z" ${fill}/><rect x="13.5" y="19" width="5" height="8" fill="#fff" fill-opacity="0.85"/>`,
    camera: `<rect x="4" y="10" width="24" height="16" rx="3" ${fill}/><path d="M11 10 L13 6 H19 L21 10" ${fill}/><circle cx="16" cy="18" r="4.5" fill="#fff" fill-opacity="0.85"/>`,
  };
  return svg(shapes[icon], 32, 32);
}

/** Google Earth's own icon for each, used in exported KML. */
export const KML_ICON_HREF: Record<PlacemarkIcon, string> = {
  dot: 'https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png',
  pushpin: 'https://maps.google.com/mapfiles/kml/pushpin/wht-pushpin.png',
  pin: 'https://maps.google.com/mapfiles/kml/paddle/wht-blank.png',
  star: 'https://maps.google.com/mapfiles/kml/shapes/star.png',
  square: 'https://maps.google.com/mapfiles/kml/shapes/placemark_square.png',
  triangle: 'https://maps.google.com/mapfiles/kml/shapes/triangle.png',
  flag: 'https://maps.google.com/mapfiles/kml/shapes/flag.png',
  home: 'https://maps.google.com/mapfiles/kml/shapes/homegardenbusiness.png',
  camera: 'https://maps.google.com/mapfiles/kml/shapes/camera.png',
};
