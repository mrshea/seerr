import PlexTvAPI from '@server/api/plextv';
import cacheManager from '@server/lib/cache';
import { getSettings } from '@server/lib/settings';
import type { AxiosInstance } from 'axios';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

function getAxios(api: PlexTvAPI): AxiosInstance {
  return (api as unknown as { axios: AxiosInstance }).axios;
}

const usersXml = `<MediaContainer>
  <User id="42" username="CurrentName">
    <Server machineIdentifier="server-id" />
  </User>
  <User id="43" username="OtherServer">
    <Server machineIdentifier="other-server" />
  </User>
  <User id="44" username="NotFriends">
    <Server machineIdentifier="server-id" />
  </User>
</MediaContainer>`;

const friends = {
  data: {
    allFriendsV2: [
      { user: { id: 'friend-uuid', username: 'currentname' } },
      { user: { id: 'other-uuid', username: 'OtherServer' } },
    ],
  },
};

const movie = {
  ratingKey: 'movie-key',
  type: 'movie',
  title: 'Movie',
  Guid: [{ id: 'tmdb://100' }],
};

const show = {
  ratingKey: 'show-key',
  type: 'show',
  title: 'Show',
  Guid: [{ id: 'tmdb://200' }, { id: 'tvdb://300' }],
};

describe('PlexTvAPI shared watchlists', () => {
  let machineId: string | undefined;

  beforeEach(() => {
    machineId = getSettings().plex.machineId;
    getSettings().plex.machineId = 'server-id';
    cacheManager.getCache('plextv').flush();
  });

  afterEach(() => {
    mock.restoreAll();
    getSettings().plex.machineId = machineId;
  });

  it('resolves account IDs to current friends and enriches shared items', async () => {
    const api = new PlexTvAPI('owner-token');
    const axios = getAxios(api);
    assert.equal(axios.defaults.headers['X-Plex-Token'], 'owner-token');
    const get = mock.method(axios, 'get', async (url: string) => {
      if (url === '/api/users') return { data: usersXml };
      if (url.endsWith('movie-key'))
        return { data: { MediaContainer: { Metadata: [movie] } } };
      if (url.endsWith('show-key'))
        return { data: { MediaContainer: { Video: [show] } } };
      if (url.endsWith('missing-key')) throw { response: { status: 404 } };
      return {
        data: { MediaContainer: { Metadata: [{ ...movie, Guid: [] }] } },
      };
    });
    const post = mock.method(
      axios,
      'post',
      async (_url: string, body: { variables?: unknown }) => ({
        data: body.variables
          ? {
              data: {
                userV2: {
                  watchlist: {
                    nodes: [
                      { id: 'movie-key' },
                      { id: 'show-key' },
                      { id: 'missing-key' },
                      { id: 'no-tmdb-key' },
                    ],
                  },
                },
              },
            }
          : friends,
      })
    );

    const expected = [
      {
        ratingKey: 'movie-key',
        type: 'movie',
        title: 'Movie',
        tmdbId: 100,
        tvdbId: undefined,
      },
      {
        ratingKey: 'show-key',
        type: 'show',
        title: 'Show',
        tmdbId: 200,
        tvdbId: 300,
      },
    ];
    assert.deepEqual(await api.getSharedWatchlist(42), expected);
    assert.deepEqual(await api.getSharedWatchlist(42), expected);
    assert.equal(
      get.mock.calls.filter((call) => call.arguments[0] === '/api/users')
        .length,
      1
    );
    assert.equal(
      post.mock.callCount(),
      3,
      'Friend lookup is reused, watchlists are fetched again'
    );
    assert.equal(
      post.mock.calls[1].arguments[0],
      'https://community.plex.tv/api'
    );
    assert.deepEqual(
      (post.mock.calls[1].arguments[1] as { variables: unknown }).variables,
      {
        user: { id: 'friend-uuid' },
        first: 20,
      }
    );
  });

  for (const [name, plexId] of [
    ['unknown account', 99],
    ['different server', 43],
    ['not friends', 44],
  ] as const) {
    it(`does not fetch a watchlist for an account with ${name}`, async () => {
      const api = new PlexTvAPI('owner-token');
      mock.method(getAxios(api), 'get', async () => ({ data: usersXml }));
      const post = mock.method(getAxios(api), 'post', async () => ({
        data: friends,
      }));

      assert.deepEqual(await api.getSharedWatchlist(plexId), []);
      assert.equal(post.mock.callCount(), 1);
    });
  }

  for (const response of [
    { data: { userV2: { watchlist: null } } },
    { data: { userV2: null } },
    { errors: [{ message: 'Not authorized' }] },
    { data: { userV2: { watchlist: { nodes: [] } } } },
  ]) {
    it('skips private, missing, or empty watchlists', async () => {
      const api = new PlexTvAPI('owner-token');
      const get = mock.method(getAxios(api), 'get', async () => ({
        data: usersXml,
      }));
      mock.method(
        getAxios(api),
        'post',
        async (_url: string, body: { variables?: unknown }) => ({
          data: body.variables ? response : friends,
        })
      );

      assert.deepEqual(await api.getSharedWatchlist(42), []);
      assert.equal(get.mock.callCount(), 1, 'No metadata is fetched');
    });
  }

  it('does not reuse friend access across owner tokens', async () => {
    const first = new PlexTvAPI('first-owner');
    mock.method(getAxios(first), 'get', async () => ({ data: usersXml }));
    mock.method(getAxios(first), 'post', async () => ({ data: friends }));
    await first.getSharedWatchlist(42);

    const second = new PlexTvAPI('second-owner');
    mock.method(getAxios(second), 'get', async () => ({ data: usersXml }));
    const post = mock.method(getAxios(second), 'post', async () => ({
      data: { data: { allFriendsV2: [] } },
    }));
    assert.deepEqual(await second.getSharedWatchlist(42), []);
    assert.equal(post.mock.callCount(), 1);
  });

  it('does not retry failed friend lookups for each imported user', async () => {
    const api = new PlexTvAPI('owner-token');
    mock.method(getAxios(api), 'get', async () => ({ data: usersXml }));
    const post = mock.method(getAxios(api), 'post', async () => {
      throw new Error('Plex unavailable');
    });

    assert.deepEqual(await api.getSharedWatchlist(42), []);
    assert.deepEqual(await api.getSharedWatchlist(43), []);
    assert.equal(post.mock.callCount(), 1);
  });
});

it('still enriches a personal watchlist through the Discover API', async () => {
  cacheManager.getCache('plextv').flush();
  cacheManager.getCache('plexwatchlist').flush();
  const api = new PlexTvAPI('personal-token');
  mock.method(getAxios(api), 'get', async (url: string) =>
    url === '/library/sections/watchlist/all'
      ? {
          status: 200,
          headers: { etag: 'version' },
          data: {
            MediaContainer: {
              totalSize: 1,
              Metadata: [{ ratingKey: 'movie-key' }],
            },
          },
        }
      : { data: { MediaContainer: { Metadata: [movie] } } }
  );

  const response = await api.getWatchlist();
  assert.equal(response.totalSize, 1);
  assert.equal(response.items[0].tmdbId, 100);
  mock.restoreAll();
});
