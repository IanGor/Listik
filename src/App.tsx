import { demoDoc, sampleDoc } from './dev/sample';
import { Outline } from './view/Outline';
import { Outliner } from './view/outliner';

// Until persistence lands (M2) the outline lives in memory: a small demo,
// or `?sample=200000` for a synthetic document at "War and Peace" scale.
const sample = Number(new URLSearchParams(location.search).get('sample'));
const started = performance.now();
const outliner = new Outliner(sample > 0 ? sampleDoc(sample) : demoDoc());
if (sample > 0) {
  console.info(`sample: ${outliner.rows.length} rows in ${Math.round(performance.now() - started)} ms`);
}

export default function App() {
  return <Outline o={outliner} />;
}
