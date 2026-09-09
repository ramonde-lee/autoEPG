import { GitHub, publishDirectory } from './releases.js';

try {
  const api = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  const count = await publishDirectory(api, process.argv[2] ?? 'dist', process.env.GITHUB_SHA ?? 'main');
  console.log(`Published/refreshed ${count} daily releases`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
