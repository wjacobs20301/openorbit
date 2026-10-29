import { Cartesian2, Cartesian3, defined, Ellipsoid, EllipsoidalOccluder, JulianDate, SceneTransforms, type Entity, type Viewer } from 'cesium';

const BALLOON_CSS = `
  body { margin: 0; font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #1b1f24; background: #fff; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 3px 8px 3px 0; border-bottom: 1px solid #e3e6eb; vertical-align: top; }
  th { color: #5f6b7a; font-weight: 500; white-space: nowrap; }
  img { max-width: 100%; }
  a { color: #1a73e8; }
`;

/**
 * Google Earth–style info balloon: click a feature to see its name and details, in a
 * popup that points at the spot and follows it as the map moves. Descriptions from
 * files can contain HTML, so they're shown in a sandboxed frame with scripts disabled.
 */
export class Balloon {
  private readonly el = document.createElement('div');
  private readonly title = document.createElement('strong');
  private readonly frame = document.createElement('iframe');
  private readonly profileLink = document.createElement('button');
  private anchor?: Cartesian3;
  private entity?: Entity;
  /** Called with a line feature when "Show elevation profile" is clicked. */
  onProfile?: (entity: Entity) => void;
  /** Called with a line feature when "Fly along" is clicked. */
  onFlyAlong?: (entity: Entity) => void;
  private readonly flyLink = document.createElement('button');
  /** Called for "Edit" on features the user can edit (their own places). */
  onEdit?: (entity: Entity) => void;
  canEdit?: (entity: Entity) => boolean;
  private readonly editLink = document.createElement('button');

  constructor(private readonly viewer: Viewer) {
    this.el.className = 'balloon';
    this.el.hidden = true;
    const head = document.createElement('div');
    head.className = 'balloon-head';
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', () => this.close());
    head.append(this.title, close);
    // No allow-scripts: file descriptions can't run code. Same-origin lets us size it.
    this.frame.setAttribute('sandbox', 'allow-same-origin allow-popups');
    this.frame.title = 'Feature details';
    this.profileLink.className = 'link';
    this.profileLink.textContent = '📈 Show elevation profile';
    this.profileLink.addEventListener('click', () => this.entity && this.onProfile?.(this.entity));
    this.editLink.className = 'link';
    this.editLink.textContent = '✎ Edit';
    this.editLink.addEventListener('click', () => {
      const entity = this.entity;
      this.close();
      if (entity) this.onEdit?.(entity);
    });
    this.flyLink.className = 'link';
    this.flyLink.textContent = '▶ Fly along this line';
    this.flyLink.addEventListener('click', () => {
      const entity = this.entity;
      this.close();
      if (entity) this.onFlyAlong?.(entity);
    });
    this.el.append(head, this.frame, this.profileLink, this.flyLink, this.editLink);
    viewer.container.append(this.el);
    viewer.scene.postRender.addEventListener(() => this.place());
  }

  /** Opens the balloon for whatever was clicked; returns false if nothing pickable was hit. */
  openAt(position: Cartesian2): boolean {
    const picked = this.viewer.scene.pick(position);
    const entity = picked?.id as Entity | undefined;
    if (!entity || !(entity.name || entity.description)) {
      this.close();
      return false;
    }
    // Draped border lines added for polygon outlines belong to their polygon.
    const target = !entity.name && entity.parent ? entity.parent : entity;
    const ground = this.viewer.scene.pickPositionSupported ? this.viewer.scene.pickPosition(position) : undefined;
    this.show(target, ground ?? target.position?.getValue(JulianDate.now()));
    return true;
  }

  show(entity: Entity, anchor?: Cartesian3): void {
    this.entity = entity;
    this.anchor = anchor;
    this.title.textContent = entity.name ?? 'Feature';
    const raw = entity.description as unknown as { getValue?: (t: JulianDate) => string } | string | undefined;
    const description = (typeof raw === 'string' ? raw : raw?.getValue?.(JulianDate.now())) ?? '';
    this.frame.hidden = !description;
    this.profileLink.hidden = !entity.polyline || !this.onProfile;
    this.editLink.hidden = !this.canEdit?.(entity);
    this.flyLink.hidden = !entity.polyline || !this.onFlyAlong;
    this.frame.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank"><style>${BALLOON_CSS}</style>${description}`;
    this.frame.onload = () => {
      const body = this.frame.contentDocument?.body;
      this.frame.style.height = `${Math.min(320, (body?.scrollHeight ?? 0) + 4)}px`;
      this.viewer.scene.requestRender();
    };
    this.el.hidden = false;
    this.viewer.scene.requestRender();
  }

  close(): void {
    this.el.hidden = true;
    this.entity = undefined;
    this.anchor = undefined;
  }

  get selected(): Entity | undefined {
    return this.entity;
  }

  /** Keeps the balloon pointing at its spot; hides it while the spot is out of view. */
  private place(): void {
    if (this.el.hidden || !this.anchor) return;
    const { scene, camera } = this.viewer;
    const occluded = !new EllipsoidalOccluder(Ellipsoid.WGS84, camera.positionWC).isPointVisible(this.anchor);
    const screen = occluded ? undefined : SceneTransforms.worldToWindowCoordinates(scene, this.anchor);
    if (!defined(screen)) {
      this.el.style.visibility = 'hidden';
      return;
    }
    this.el.style.visibility = '';
    this.el.style.left = `${screen.x}px`;
    this.el.style.top = `${screen.y}px`;
  }
}
