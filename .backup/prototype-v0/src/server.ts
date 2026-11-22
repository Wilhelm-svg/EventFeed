import { createApp } from './app.js';
import { createDb } from './db.js';

const app = createApp({ db: createDb('data/eventfeed.db') });

// Local only: there is no authentication, so never bind to a public interface.
app.listen(3000, '127.0.0.1', () => console.log('EventFeed running at http://127.0.0.1:3000/api'));
