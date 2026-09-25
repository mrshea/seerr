import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, describe, it, mock } from 'node:test';

import JellyfinAPI from '@server/api/jellyfin';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { checkUser, isAuthenticated } from '@server/middleware/auth';
import authRoutes from '@server/routes/auth';
import { setupTestDb } from '@server/test/db';
import type { Express } from 'express';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import userRoutes from '.';

const defaultAuthenticateResponse = {
  User: {
    Id: 'jf-link-user-001',
    Name: 'linkeduser',
    ServerId: 'server-1',
    Policy: { IsAdministrator: false },
  },
  AccessToken: 'fake-qc-access-token',
};

const authenticateQCMock = mock.method(
  JellyfinAPI.prototype,
  'authenticateQuickConnect',
  async () => ({ ...defaultAuthenticateResponse })
);

let app: Express;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    session({
      secret: 'test-secret',
      resave: false,
      saveUninitialized: false,
    })
  );
  app.use(checkUser);
  app.use('/auth', authRoutes);
  app.use('/user', isAuthenticated(), userRoutes);
  app.use(
    (
      err: { status?: number; message?: string },
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction
    ) => {
      res
        .status(err.status ?? 500)
        .json({ status: err.status ?? 500, message: err.message });
    }
  );
  return app;
}

before(async () => {
  app = createApp();
});

setupTestDb();

function configureJellyfin() {
  const settings = getSettings();
  settings.main.mediaServerType = MediaServerType.JELLYFIN;
  settings.jellyfin.ip = 'localhost';
  settings.jellyfin.port = 8096;
  settings.jellyfin.useSsl = false;
  settings.jellyfin.urlBase = '';
}

async function loginAs(email: string, password: string) {
  const settings = getSettings();
  settings.main.localLogin = true;

  const agent = request.agent(app);
  const res = await agent.post('/auth/local').send({ email, password });

  assert.strictEqual(res.status, 200);
  return { agent, userId: res.body.id as number };
}

describe('User watchlist defaults', () => {
  afterEach(() => {
    getSettings().main.autoEnableWatchlistSync = false;
  });

  for (const enabled of [false, true]) {
    it(`uses automatic enablement (${enabled}) for unset preferences`, async () => {
      getSettings().main.autoEnableWatchlistSync = enabled;
      const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
      const url = `/user/${userId}/settings/main`;

      // Cover no settings record, a settings save, and persisted null preferences.
      const initial = await agent.get(url);
      const saved = await agent.post(url).send({ locale: 'en' });
      const loaded = await agent.get(url);
      for (const res of [initial, saved, loaded]) {
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.watchlistSyncMovies, enabled);
        assert.strictEqual(res.body.watchlistSyncTv, enabled);
      }

      getSettings().main.autoEnableWatchlistSync = !enabled;
      const updated = await agent.get(url);
      assert.strictEqual(updated.body.watchlistSyncMovies, !enabled);
      assert.strictEqual(updated.body.watchlistSyncTv, !enabled);
    });
  }

  it('allows users to opt out of inherited preferences', async () => {
    getSettings().main.autoEnableWatchlistSync = true;
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const saved = await agent.post(`/user/${userId}/settings/main`).send({
      watchlistSyncMovies: false,
      watchlistSyncTv: false,
    });
    const unrelated = await agent
      .post(`/user/${userId}/settings/main`)
      .send({ locale: 'en' });
    const loaded = await agent.get(`/user/${userId}/settings/main`);
    for (const res of [saved, unrelated, loaded]) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.watchlistSyncMovies, false);
      assert.strictEqual(res.body.watchlistSyncTv, false);
    }
  });
});

describe('POST /user/:id/settings/linked-accounts/jellyfin/quickconnect', () => {
  beforeEach(() => {
    authenticateQCMock.mock.resetCalls();
    authenticateQCMock.mock.mockImplementation(async () => ({
      ...defaultAuthenticateResponse,
    }));
    configureJellyfin();
  });

  it('links the account when the media server is Jellyfin', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 204);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 1);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, 'jf-link-user-001');
    assert.strictEqual(user.userType, UserType.JELLYFIN);
  });

  it('returns 403 when the media server is Emby', async () => {
    const { agent, userId } = await loginAs('demo@seerr.dev', 'test1234');
    getSettings().main.mediaServerType = MediaServerType.EMBY;

    const res = await agent
      .post(`/user/${userId}/settings/linked-accounts/jellyfin/quickconnect`)
      .send({ secret: 'abc123def456abc123def456' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(authenticateQCMock.mock.callCount(), 0);

    const user = await getRepository(User).findOneOrFail({
      where: { id: userId },
    });
    assert.strictEqual(user.jellyfinUserId, null);
  });
});
