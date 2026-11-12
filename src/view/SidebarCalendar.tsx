import { For, createMemo, createSignal, onCleanup } from 'solid-js';
import { isoWeek } from '../model/calendar';
import type { Outliner } from './outliner';

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Small, local-date calendar; browsing never changes the document. */
export function SidebarCalendar(props: { o: Outliner; open: boolean; onNavigate: () => void }) {
  const [today, setToday] = createSignal(new Date());
  const [month, setMonth] = createSignal(new Date(today().getFullYear(), today().getMonth(), 1));
  const tick = setInterval(() => setToday(new Date()), 60_000);
  onCleanup(() => clearInterval(tick));
  const weeks = createMemo(() => {
    const first = month();
    const offset = (first.getDay() + 6) % 7;
    const count = Math.ceil((offset + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
    return Array.from({ length: count }, (_, row) => Array.from({ length: 7 }, (_, col) =>
      new Date(first.getFullYear(), first.getMonth(), 1 - offset + row * 7 + col, 12)));
  });
  const move = (step: number) => setMonth((date) => new Date(date.getFullYear(), date.getMonth() + step, 1));
  const label = () => month().toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return <section class="sidebar-calendar" hidden={!props.open} aria-label="Календарь">
    <div class="sidebar-calendar-head">
      <button type="button" aria-label="Предыдущий месяц" onClick={() => move(-1)}>‹</button>
      <button type="button" class="sidebar-calendar-month" title="Вернуться к текущему месяцу" aria-label={`${label()}: вернуться к текущему месяцу`}
        onClick={() => { const now = new Date(); setToday(now); setMonth(new Date(now.getFullYear(), now.getMonth(), 1)); }}>{label()}</button>
      <button type="button" aria-label="Следующий месяц" onClick={() => move(1)}>›</button>
    </div>
    <table>
      <thead><tr><th scope="col" aria-label="Неделя">W</th><For each={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']}>{(day) => <th scope="col">{day}</th>}</For></tr></thead>
      <tbody><For each={weeks()}>{(week) => {
        const w = isoWeek(week[0].getFullYear(), week[0].getMonth() + 1, week[0].getDate());
        return <tr>
          <th scope="row"><button type="button" class="sidebar-calendar-week" aria-label={`Неделя ${w}, ${label()}`}
            onClick={() => { props.o.goToCalendarWeek(month().getFullYear(), month().getMonth() + 1, w); props.onNavigate(); }}>{w}</button></th>
          <For each={week}>{(date) => <td><button type="button" data-date={dateKey(date)}
            classList={{ 'other-month': date.getMonth() !== month().getMonth(), 'is-today': dateKey(date) === dateKey(today()) }}
            aria-current={dateKey(date) === dateKey(today()) ? 'date' : undefined}
            aria-label={date.toLocaleDateString('ru', { day: 'numeric', month: 'long', year: 'numeric' })}
            onClick={() => { props.o.goToDate({ y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }); props.onNavigate(); }}>{date.getDate()}</button></td>}</For>
        </tr>;
      }}</For></tbody>
    </table>
  </section>;
}
