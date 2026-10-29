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
