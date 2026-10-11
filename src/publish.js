import { GitHub, publishDirectory } from './releases.js';

try {
  const api = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  const published = await publishDirectory(api, process.argv[2] ?? 'dist', process.env.GITHUB_SHA ?? 'main', {
    rebuild: process.env.REBUILD_RELEASES === 'true',
  });
  if (!published) {
    console.log('No release published (no current-day EPG)');
  } else {
    console.log(`Published current-day release (${published} release)`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
