import { parseArgs } from 'node:util';
import { Yangshipin } from './source.js';
import { collect, dateKey, writeArtifacts } from './epg.js';

try {
  const { values } = parseArgs({ options: {
    output: { type: 'string', default: 'dist' },
    date: { type: 'string', default: dateKey(Date.now() / 1000) },
    'past-days': { type: 'string', default: '3' },
    'future-days': { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' },
    'min-channels': { type: 'string', default: '50' },
    'min-today-coverage': { type: 'string', default: '0.9' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('npm run generate -- [--output dist] [--date YYYY-MM-DD] [--past-days 3] [--future-days 3] [--concurrency 4] [--min-channels 50] [--min-today-coverage 0.9]');
  } else {
    const integer = (key, min, max) => {
      const value = Number(values[key]);
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${key} must be ${min}..${max}`);
      return value;
    };
    const minTodayCoverage = Number(values['min-today-coverage']);
    if (!Number.isFinite(minTodayCoverage) || minTodayCoverage <= 0 || minTodayCoverage > 1) {
      throw new Error('--min-today-coverage must be greater than 0 and at most 1');
    }
    console.log(`Fetching Yangshipin schedules for ${values.date} (Asia/Shanghai)`);
    const dataset = await collect(new Yangshipin(), {
      today: values.date, pastDays: integer('past-days', 0, 7), futureDays: integer('future-days', 0, 7),
      concurrency: integer('concurrency', 1, 8), minChannels: integer('min-channels', 1, 1000),
      minTodayCoverage,
      onProgress: (done, total) => { if (done % 50 === 0 || done === total) console.log(`Schedules ${done}/${total}`); },
    });
    await writeArtifacts(values.output, dataset);
    console.log(JSON.stringify(dataset.manifest, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
