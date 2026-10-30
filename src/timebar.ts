import { ClockRange, JulianDate, TimeIntervalCollection, type DataSource, type Entity, type Viewer } from 'cesium';

/** A whole run of the data takes this long when playing. */
const PLAY_SECONDS = 30;
const STEPS = 1000;
/** Open-ended intervals use Cesium's extreme dates; those don't count towards the range. */
const FAR_PAST = JulianDate.fromIso8601('0100-01-01');
const FAR_FUTURE = JulianDate.fromIso8601('9000-01-01');

/**
 * The time slider Google Earth shows for KML with <TimeStamp> or <TimeSpan> (GPS tracks,
 * earthquake feeds…). It appears while such data is loaded: drag to a moment, press play
 * to animate, or tick "Show all" to see every feature at once.
 */
export function setupTimeBar(viewer: Viewer): void {
  const bar = document.createElement('div');
  bar.id = 'kml-time-bar';
  bar.className = 'map-bar';
  bar.hidden = true;
  bar.innerHTML = `<div class="row">
      <button class="play" title="Play" aria-label="Play">▶</button>
      <strong class="time-label"></strong>
      <span class="spacer"></span>
      <label class="check"><input type="checkbox" class="all" checked /> Show all</label>
      <button class="close" title="Hide the time slider" aria-label="Close">&times;</button>
    </div>
    <input type="range" class="wide" min="0" max="${STEPS}" step="1" aria-label="Time" />`;
  document.querySelector('#globe')!.append(bar);
  const play = bar.querySelector<HTMLButtonElement>('.play')!;
  const label = bar.querySelector<HTMLElement>('.time-label')!;
  const all = bar.querySelector<HTMLInputElement>('.all')!;
  const slider = bar.querySelector<HTMLInputElement>('input[type=range]')!;
  const { clock } = viewer;

  let range: { start: JulianDate; stop: JulianDate } | undefined;
  /** Each timed entity's own availability, set aside while "Show all" is on. */
  const saved = new Map<Entity, TimeIntervalCollection>();
  let dismissed = false;

  const sources = () => Array.from({ length: viewer.dataSources.length }, (_, i) => viewer.dataSources.get(i));

  const showAll = (on: boolean) => {
    if (on) {
      for (const ds of sources()) {
        for (const e of ds.entities.values) {
          if (e.availability && !saved.has(e)) {
            saved.set(e, e.availability);
            e.availability = undefined as never;
          }
        }
      }
    } else {
      for (const [e, availability] of saved) e.availability = availability;
      saved.clear();
    }
    all.checked = on;
    viewer.scene.requestRender();
  };

  const show = () => {
    const t = clock.currentTime;
    label.textContent = all.checked
      ? `${fmt(range!.start)} – ${fmt(range!.stop)}`
      : fmt(t);
    const total = JulianDate.secondsDifference(range!.stop, range!.start) || 1;
    slider.value = String(Math.round((JulianDate.secondsDifference(t, range!.start) / total) * STEPS));
  };

  const pause = () => {
    clock.shouldAnimate = false;
    play.textContent = '▶';
    play.title = 'Play';
  };

  /** Finds the time range of everything loaded and shows or hides the bar. */
  const refresh = () => {
    let start: JulianDate | undefined;
    let stop: JulianDate | undefined;
    // From the features' own dates: Cesium's data source clock runs on to today for <TimeStamp>s.
    const consider = (t: JulianDate) => {
      if (JulianDate.lessThan(t, FAR_PAST) || JulianDate.greaterThan(t, FAR_FUTURE)) return;
      if (!start || JulianDate.lessThan(t, start)) start = t;
      if (!stop || JulianDate.greaterThan(t, stop)) stop = t;
    };
    for (const ds of sources()) {
      if (!ds.show) continue;
      for (const e of ds.entities.values) {
        const availability = saved.get(e) ?? e.availability;
        for (let i = 0; i < (availability?.length ?? 0); i++) {
          const interval = availability!.get(i);
          if (!interval) continue;
          consider(interval.start);
          consider(interval.stop);
        }
      }
    }
    if (!start || !stop) {
      range = undefined;
      bar.hidden = true;
      pause();
      return;
    }
    const isNew = !range;
    range = { start, stop };
    clock.startTime = start.clone();
    clock.stopTime = stop.clone();
    clock.clockRange = ClockRange.LOOP_STOP;
    if (isNew) {
      clock.currentTime = stop.clone();
      dismissed = false;
    }
    if (all.checked) showAll(true);
    bar.hidden = dismissed;
    show();
  };

  slider.addEventListener('input', () => {
    if (!range) return;
    pause();
    showAll(false);
    const total = JulianDate.secondsDifference(range.stop, range.start);
    clock.currentTime = JulianDate.addSeconds(range.start, (Number(slider.value) / STEPS) * total, new JulianDate());
    show();
    viewer.scene.requestRender();
  });
  play.addEventListener('click', () => {
    if (!range) return;
    if (clock.shouldAnimate) return pause();
    showAll(false);
    if (JulianDate.greaterThanOrEquals(clock.currentTime, range.stop)) clock.currentTime = range.start.clone();
    clock.multiplier = Math.max(1, JulianDate.secondsDifference(range.stop, range.start) / PLAY_SECONDS);
    clock.shouldAnimate = true;
    play.textContent = '⏸';
    play.title = 'Pause';
  });
  all.addEventListener('change', () => {
    pause();
    showAll(all.checked);
    show();
  });
  bar.querySelector('.close')!.addEventListener('click', () => {
    pause();
    showAll(true);
    dismissed = true;
    bar.hidden = true;
  });
  clock.onTick.addEventListener(() => {
    if (!clock.shouldAnimate || !range) return;
    show();
    viewer.scene.requestRender();
  });

  const watch = (ds: DataSource) => {
    ds.entities.collectionChanged.addEventListener(() => queueMicrotask(refresh));
    refresh();
  };
  for (const ds of sources()) watch(ds);
  viewer.dataSources.dataSourceAdded.addEventListener((_, ds) => watch(ds));
  viewer.dataSources.dataSourceRemoved.addEventListener((_, ds) => {
    for (const e of [...saved.keys()]) if (ds.entities.contains(e)) saved.delete(e);
    refresh();
  });
}

/** A date (and time, unless it's midnight UTC) for the label. */
function fmt(t: JulianDate): string {
  const d = JulianDate.toDate(t);
  const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
  return d.toLocaleString(undefined, midnight
    ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }
    : { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
