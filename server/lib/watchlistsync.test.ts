import type { PlexWatchlistItem } from '@server/api/plextv';
import PlexTvAPI from '@server/api/plextv';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { UserSettings } from '@server/entity/UserSettings';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import watchlistSync from '@server/lib/watchlistsync';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

let watchlistItems: PlexWatchlistItem[] = [];

Object.defineProperty(PlexTvAPI.prototype, 'getWatchlist', {
  get() {
    return async () => ({
      offset: 0,
      size: 20,
      totalSize: watchlistItems.length,
      items: watchlistItems,
    });
  },
  set() {},
  configurable: true,
});

let requestCalls: {
  mediaId: number;
  mediaType: MediaType;
  userId: number;
}[] = [];

Object.defineProperty(MediaRequest, 'request', {
  value: async (
    body: { mediaId: number; mediaType: MediaType },
    user: User
  ) => {
    requestCalls.push({
      mediaId: body.mediaId,
      mediaType: body.mediaType,
      userId: user.id,
    });
    return {} as MediaRequest;
  },
  writable: true,
  configurable: true,
});

setupTestDb();

async function configureSyncUser(): Promise<User> {
  const userRepository = getRepository(User);
  const admin = await userRepository.findOneOrFail({ where: { id: 1 } });

  admin.plexToken = 'test-plex-token';
  admin.permissions = Permission.AUTO_REQUEST;
  await userRepository.save(admin);

  const userSettingsRepository = getRepository(UserSettings);
  await userSettingsRepository.save(
    new UserSettings({
      user: admin,
      watchlistSyncMovies: true,
      watchlistSyncTv: true,
    })
  );

  return admin;
}

async function seedMedia(
  tmdbId: number,
  mediaType: MediaType,
  status: MediaStatus
): Promise<void> {
  const mediaRepository = getRepository(Media);
  await mediaRepository.save(
    new Media({
      tmdbId,
      mediaType,
      status,
      status4k: MediaStatus.UNKNOWN,
    })
  );
}

function movieItem(tmdbId: number, title: string): PlexWatchlistItem {
  return { ratingKey: `rk-${tmdbId}`, tmdbId, title, type: 'movie' };
}

function showItem(tmdbId: number, title: string): PlexWatchlistItem {
  return {
    ratingKey: `rk-${tmdbId}`,
    tmdbId,
    tvdbId: tmdbId * 1000,
    title,
    type: 'show',
  };
}

describe('WatchlistSync automatic enablement', () => {
  beforeEach(async () => {
    requestCalls = [];
    watchlistItems = [movieItem(100, 'Movie'), showItem(200, 'Show')];
    await getRepository(User).update(1, { plexToken: '' });
  });

  afterEach(() => {
    getSettings().main.autoEnableWatchlistSync = false;
  });

  const cases: {
    name: string;
    enabled: boolean;
    permissions: Permission;
    expected: MediaType[];
  }[] = [
    {
      name: 'does not auto-request when automatic enablement is off',
      enabled: false,
      permissions: Permission.AUTO_REQUEST,
      expected: [],
    },
    {
      name: 'auto-requests both media types when automatic enablement is on',
      enabled: true,
      permissions: Permission.AUTO_REQUEST,
      expected: [MediaType.MOVIE, MediaType.TV],
    },
    {
      name: 'still requires auto-request permission',
      enabled: true,
      permissions: Permission.REQUEST,
      expected: [],
    },
    {
      name: 'respects movie-only auto-request permission',
      enabled: true,
      permissions: Permission.AUTO_REQUEST_MOVIE,
      expected: [MediaType.MOVIE],
    },
    {
      name: 'respects series-only auto-request permission',
      enabled: true,
      permissions: Permission.AUTO_REQUEST_TV,
      expected: [MediaType.TV],
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      getSettings().main.autoEnableWatchlistSync = testCase.enabled;
      await getRepository(User).update(2, {
        permissions: testCase.permissions,
      });

      await watchlistSync.syncWatchlist();

      assert.deepStrictEqual(
        requestCalls.map((call) => call.mediaType),
        testCase.expected
      );
    });
  }

  it('automatically enables null preferences', async () => {
    getSettings().main.autoEnableWatchlistSync = true;
    await getRepository(User).update(2, {
      permissions: Permission.AUTO_REQUEST,
    });
    await getRepository(UserSettings).save(
      new UserSettings({ user: { id: 2 } as User })
    );

    await watchlistSync.syncWatchlist();

    assert.deepStrictEqual(
      requestCalls.map((call) => call.mediaType),
      [MediaType.MOVIE, MediaType.TV]
    );
  });

  it('preserves per-media opt-outs with automatic enablement', async () => {
    getSettings().main.autoEnableWatchlistSync = true;
    await getRepository(User).update(2, {
      permissions: Permission.AUTO_REQUEST,
    });
    const preferences = await getRepository(UserSettings).save(
      new UserSettings({
        user: { id: 2 } as User,
        watchlistSyncMovies: false,
      })
    );

    await watchlistSync.syncWatchlist();
    assert.deepStrictEqual(
      requestCalls.map((call) => call.mediaType),
      [MediaType.TV]
    );

    requestCalls = [];
    await getRepository(UserSettings).update(preferences.id, {
      watchlistSyncTv: false,
    });
    await watchlistSync.syncWatchlist();
    assert.deepStrictEqual(requestCalls, []);
  });
});

describe('WatchlistSync imported users', () => {
  beforeEach(async () => {
    requestCalls = [];
    watchlistItems = [movieItem(100, 'Movie'), showItem(200, 'Show')];
    getSettings().main.autoEnableWatchlistSync = true;
    await getRepository(User).update(1, { permissions: Permission.NONE });
    await getRepository(User).update(2, {
      plexId: 42,
      plexToken: '',
      permissions: Permission.AUTO_REQUEST,
    });
  });

  afterEach(() => {
    mock.restoreAll();
    getSettings().main.autoEnableWatchlistSync = false;
  });

  it('stops imported-user sync when disabled, even with saved opt-ins', async () => {
    const shared = mock.method(
      PlexTvAPI.prototype,
      'getSharedWatchlist',
      async () => watchlistItems
    );
    await getRepository(UserSettings).save(
      new UserSettings({
        user: { id: 2 } as User,
        watchlistSyncMovies: true,
        watchlistSyncTv: true,
      })
    );

    await watchlistSync.syncWatchlist();
    assert.equal(shared.mock.callCount(), 1);
    assert.equal(requestCalls.length, 2);

    getSettings().main.autoEnableWatchlistSync = false;
    requestCalls = [];
    await watchlistSync.syncWatchlist();
    assert.equal(shared.mock.callCount(), 1);
    assert.deepEqual(requestCalls, []);
  });

  it('keeps existing personal-token sync working when disabled', async () => {
    getSettings().main.autoEnableWatchlistSync = false;
    await getRepository(User).update(2, { plexToken: 'personal-token' });
    await getRepository(UserSettings).save(
      new UserSettings({
        user: { id: 2 } as User,
        watchlistSyncMovies: true,
        watchlistSyncTv: false,
      })
    );

    await watchlistSync.syncWatchlist();
    assert.deepEqual(requestCalls, [
      { mediaId: 100, mediaType: MediaType.MOVIE, userId: 2 },
    ]);
  });

  it('uses the owner token and attributes requests to the imported user', async () => {
    const shared = mock.method(
      PlexTvAPI.prototype,
      'getSharedWatchlist',
      async function (this: PlexTvAPI, plexId: number) {
        assert.equal(plexId, 42);
        assert.equal(
          (this as unknown as { authToken: string }).authToken,
          '1234'
        );
        return watchlistItems;
      }
    );

    await watchlistSync.syncWatchlist();

    assert.equal(shared.mock.callCount(), 1);
    assert.deepEqual(requestCalls, [
      { mediaId: 100, mediaType: MediaType.MOVIE, userId: 2 },
      { mediaId: 200, mediaType: MediaType.TV, userId: 2 },
    ]);
  });

  it('retains media permissions and explicit opt-outs for imported users', async () => {
    mock.method(
      PlexTvAPI.prototype,
      'getSharedWatchlist',
      async () => watchlistItems
    );
    await getRepository(User).update(2, {
      permissions: Permission.AUTO_REQUEST_MOVIE,
    });

    await watchlistSync.syncWatchlist();
    assert.deepEqual(requestCalls, [
      { mediaId: 100, mediaType: MediaType.MOVIE, userId: 2 },
    ]);

    requestCalls = [];
    await getRepository(UserSettings).save(
      new UserSettings({ user: { id: 2 } as User, watchlistSyncMovies: false })
    );
    await watchlistSync.syncWatchlist();
    assert.deepEqual(requestCalls, []);
  });

  for (const scenario of [
    'automatic enablement off',
    'no permission',
    'no owner token',
    'local user',
    'no Plex ID',
  ]) {
    it(`does not fetch a shared watchlist with ${scenario}`, async () => {
      const shared = mock.method(
        PlexTvAPI.prototype,
        'getSharedWatchlist',
        async () => watchlistItems
      );
      if (scenario === 'automatic enablement off') {
        getSettings().main.autoEnableWatchlistSync = false;
      } else if (scenario === 'no permission') {
        await getRepository(User).update(2, {
          permissions: Permission.REQUEST,
        });
      } else if (scenario === 'no owner token') {
        await getRepository(User).update(1, { plexToken: '' });
      } else if (scenario === 'local user') {
        await getRepository(User).update(2, { userType: UserType.LOCAL });
      } else {
        await getRepository(User).update(2, { plexId: null });
      }

      await watchlistSync.syncWatchlist();
      assert.equal(shared.mock.callCount(), 0);
      assert.deepEqual(requestCalls, []);
    });
  }

  it('uses the personal token when a user has already signed in', async () => {
    const shared = mock.method(
      PlexTvAPI.prototype,
      'getSharedWatchlist',
      async () => []
    );
    await getRepository(User).update(2, { plexToken: 'personal-token' });

    await watchlistSync.syncWatchlist();

    assert.equal(shared.mock.callCount(), 0);
    assert.equal(requestCalls.length, 2);
  });

  it('continues syncing signed-in users when a shared watchlist is unavailable', async () => {
    mock.method(PlexTvAPI.prototype, 'getSharedWatchlist', async () => []);
    await getRepository(User).save(
      new User({
        email: 'signed-in@example.com',
        avatar: '',
        plexToken: 'personal-token',
        userType: UserType.PLEX,
        permissions: Permission.AUTO_REQUEST,
      })
    );

    await watchlistSync.syncWatchlist();

    assert.deepEqual(
      requestCalls.map((call) => call.userId),
      [3, 3]
    );
  });
});

describe('WatchlistSync re-request gating', () => {
  beforeEach(() => {
    requestCalls = [];
    watchlistItems = [];
  });

  it('re-requests DELETED watchlist items and skips non-requestable ones', async () => {
    await configureSyncUser();

    await seedMedia(100, MediaType.MOVIE, MediaStatus.DELETED);
    await seedMedia(101, MediaType.MOVIE, MediaStatus.UNKNOWN);
    await seedMedia(102, MediaType.MOVIE, MediaStatus.AVAILABLE);
    await seedMedia(103, MediaType.MOVIE, MediaStatus.BLOCKLISTED);

    await seedMedia(200, MediaType.TV, MediaStatus.DELETED);
    await seedMedia(201, MediaType.TV, MediaStatus.AVAILABLE);

    watchlistItems = [
      movieItem(100, 'Deleted Movie'),
      movieItem(101, 'Unknown Movie'),
      movieItem(102, 'Available Movie'),
      movieItem(103, 'Blocklisted Movie'),
      showItem(200, 'Deleted Show'),
      showItem(201, 'Available Show'),
    ];

    await watchlistSync.syncWatchlist();

    const requestedArray = requestCalls.map(
      (c) => `${c.mediaType}:${c.mediaId}`
    );
    const requested = new Set(requestedArray);

    assert.strictEqual(
      requestedArray.length,
      requested.size,
      'Each item should be requested exactly once'
    );

    assert.ok(
      requested.has(`${MediaType.MOVIE}:100`),
      'DELETED movie on the watchlist should be re-requested'
    );

    assert.ok(
      requested.has(`${MediaType.MOVIE}:101`),
      'UNKNOWN movie should be requested'
    );
    assert.ok(
      !requested.has(`${MediaType.MOVIE}:102`),
      'AVAILABLE movie should NOT be requested'
    );
    assert.ok(
      !requested.has(`${MediaType.MOVIE}:103`),
      'BLOCKLISTED movie should NOT be requested'
    );

    assert.ok(
      requested.has(`${MediaType.TV}:200`),
      'DELETED show should be re-requested'
    );
    assert.ok(
      !requested.has(`${MediaType.TV}:201`),
      'AVAILABLE show should NOT be requested'
    );
  });

  it('re-requests DELETED watchlist items even when a stale auto-request exists', async () => {
    const user = await configureSyncUser();

    await seedMedia(100, MediaType.MOVIE, MediaStatus.DELETED);

    const media = await getRepository(Media).findOneOrFail({
      where: { tmdbId: 100, mediaType: MediaType.MOVIE },
    });

    await getRepository(MediaRequest).save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.COMPLETED,
        media,
        requestedBy: user,
        is4k: false,
        isAutoRequest: true,
      })
    );

    watchlistItems = [movieItem(100, 'Deleted Movie')];

    await watchlistSync.syncWatchlist();

    const calls = requestCalls.filter(
      (c) => c.mediaType === MediaType.MOVIE && c.mediaId === 100
    );

    assert.strictEqual(
      calls.length,
      1,
      'DELETED movie should be re-requested even when a stale auto-request exists'
    );
  });
});
