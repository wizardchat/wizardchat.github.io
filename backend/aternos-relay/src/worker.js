const Aternos = require('@rifaichump/aternos');

function send(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

function fail(err) {
  send({ error: String(err && err.message ? err.message : err) });
}

(async () => {
  const task = process.argv[2] || 'login';
  try {
    if (task === 'login') {
      const user = process.env.ATERNOS_USER || '';
      const pass = process.env.ATERNOS_PASSWORD || '';
      if (!user || !pass) return fail(new Error('ATERNOS_USER / ATERNOS_PASSWORD not set'));
      const cookies = await Aternos.loginToAternos(user, pass);
      if (!Array.isArray(cookies)) return fail(new Error('login returned no cookies'));
      send({ cookies });
    }

    const cookies = JSON.parse(Buffer.from(process.env.ATERNOS_COOKIES || 'bnVsbA==', 'base64').toString()) || null;
    if (!Array.isArray(cookies)) return fail(new Error('no session cookies'));

    if (task === 'server') {
      const { servers } = await Aternos.getServerList(cookies);
      const mapped = (servers || []).map((s) => ({
        name: s.name ?? null,
        id: s.id ?? null,
        status: s.status ?? 'unknown',
        software: s.software ?? null,
        players: s.players ?? null,
      }));
      return send({ servers: mapped });
    }

    if (task === 'start' || task === 'stop' || task === 'restart') {
      const id = process.env.ATERNOS_SERVER_ID || '';
      if (!id) return fail(new Error('ATERNOS_SERVER_ID not set for ' + task));
      const result = await Aternos.manageServer(cookies, id, task);
      return send({
        result: {
          success: !!(result && result.success),
          status: (result && result.status) || null,
          message: (result && result.message) || task,
          timeRemaining: (result && result.timeRemaining) || null,
        },
      });
    }

    send({ error: 'unknown task: ' + task });
  } catch (err) {
    fail(err);
  }
})();