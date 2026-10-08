// Every API route, in one list. worker.js compiles it; scripts/smoke.mjs
// reads it back (via /api/_routes in dev) and fails if a route goes untested.

import auth from './auth.js';
import me from './me.js';
import users from './users.js';
import org from './org.js';
import feed from './feed.js';
import projects from './projects.js';
import tasks from './tasks.js';
import comments from './comments.js';
import templates from './templates.js';
import people from './people.js';
import misc from './misc.js';
import team from './team.js';

export default [
  ...auth, ...me, ...users, ...org, ...feed, ...projects, ...tasks, ...comments, ...templates, ...people, ...misc, ...team,
];
