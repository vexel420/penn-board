// Hubs (owner, Nov 25: "port all of the same features to both"): every
// station board runs the same engine (feeds.js + app.js + airport.js); this
// file is what differs between them. A page picks its hub by setting
// window.HUB_ID before loading this file ('nyp' if it doesn't).
(function () {
  const HUBS = {
    nyp: {
      id: 'nyp', name: 'Penn Station', short: 'Penn', kicker: 'New York', title: 'Penn Station', subwayTab: 'subway and PATH',
      pill: { href: 'gct.html', label: 'Grand Central' },
      ll: [40.7506, -73.9935],
      directions: { google: 'https://www.google.com/maps/dir/?api=1&origin=34+St-Penn+Station,+New+York,+NY&travelmode=transit', apple: 'https://maps.apple.com/?saddr=Penn+Station,+New+York,+NY&dirflg=r' },
      // Subway stations at the hub, their lines, and how each direction is named.
      stations: [{ id: '128', lines: ['1', '2', '3'] }, { id: 'A28', lines: ['A', 'C', 'E'] }],
      dirs: { '128': { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, A28: { N: 'Uptown and Queens', S: 'Downtown and Brooklyn' } },
      subwayFeeds: ['gtfs', 'gtfs-ace', 'gtfs-bdfm'],
      subwayAlerts: 'subway',
      // Railroads on the board, and the LIRR's stop id for this hub in its timetable.
      rails: ['lirr', 'njt', 'amtrak'], lirrStop: '237', lirrCode: 'NYK',
      path: true, buses: true,
      elevatorStations: ['34 St-Penn Station'],
      eventVenues: /Madison Square Garden|UBS Arena/i,
      busStops: [
        { stop: '401819', lines: ['M34-SBS', 'M34A-SBS'], label: '34 St crosstown, eastbound', where: 'W 34 St at 8 Av' },
        { stop: '401848', lines: ['M34-SBS'], label: '34 St crosstown, to Javits Center', where: 'W 34 St at 8 Av' },
        { stop: '401231', lines: ['M34A-SBS'], label: 'To Port Authority on 8 Av', where: '8 Av at W 34 St' },
        { stop: '404847', lines: ['M20'], label: 'Uptown on 8 Av', where: '8 Av at W 31 St' },
        { stop: '401360', lines: ['M20', 'M7'], label: 'Downtown on 7 Av', where: '7 Av at W 34 St' },
      ],
    },
    gct: {
      id: 'gct', name: 'Grand Central', short: 'Grand Central', kicker: 'New York', title: 'Grand Central', subwayTab: 'subway and buses',
      pill: { href: 'index.html', label: 'Penn Station' },
      ll: [40.7527, -73.9772],
      directions: { google: 'https://www.google.com/maps/dir/?api=1&origin=Grand+Central+Terminal+New+York&travelmode=transit', apple: 'https://maps.apple.com/?saddr=Grand+Central+Terminal+New+York&dirflg=r' },
      stations: [{ id: '631', lines: ['4', '5', '6'] }, { id: '723', lines: ['7'] }, { id: '901', lines: ['GS'] }],
      dirs: { 631: { N: 'Uptown and the Bronx', S: 'Downtown and Brooklyn' }, 723: { N: 'Queens', S: 'Times Sq and Hudson Yards' }, 901: { N: 'Times Sq-42 St', S: 'Times Sq-42 St' } },
      subwayFeeds: ['gtfs'],
      subwayAlerts: 'subway-gct',
      rails: ['mnr', 'lirr'], lirrStop: '349', lirrCode: 'GCT', mnrStop: '1', mnrCode: '0NY',
      path: false, buses: false,
      elevatorStations: ['Grand Central-42 St'],
      eventVenues: /UBS Arena|Yankee Stadium|Citi Field/i,
      busStops: [
        { stop: '405241', lines: ['M42'], label: '42 St crosstown, westbound', where: 'E 42 St at Park Av' },
        { stop: '403459', lines: ['M42'], label: '42 St crosstown, eastbound', where: 'E 42 St at Park Av' },
        { stop: '402843', lines: ['M101', 'M102', 'M103'], label: 'Downtown on Lexington Av', where: 'Lexington Av at E 45 St' },
        { stop: '402679', lines: ['M101', 'M102', 'M103'], label: 'Uptown on 3 Av', where: '3 Av at E 42 St' },
        { stop: '400018', lines: ['M1', 'M2'], label: 'Uptown on Madison Av', where: 'Madison Av at E 43 St' },
        { stop: '400561', lines: ['M3', 'M4'], label: 'Uptown on Madison Av', where: 'Madison Av at E 42 St' },
      ],
    },
  };
  const id = (typeof window !== 'undefined' && window.HUB_ID) || 'nyp';
  const root = typeof window !== 'undefined' ? window : globalThis;
  root.HUBS = HUBS;
  root.HUB = HUBS[id] || HUBS.nyp;
})();
