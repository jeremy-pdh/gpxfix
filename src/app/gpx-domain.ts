export interface LatLon {
  lat: number;
  lon: number;
}

export interface TrackPoint extends LatLon {
  ele: number | null;
  time: Date | null;
  source: 'original' | 'generated';
}

export interface GpxTrack {
  name: string;
  metadataXml: string | null;
  points: TrackPoint[];
}

export interface GapCandidate {
  startIndex: number;
  endIndex: number;
  distanceMeters: number;
  durationSeconds: number | null;
  speedKph: number | null;
  score: number;
}

export interface RouteLeg {
  coordinates: LatLon[];
  distanceMeters: number;
  durationSeconds: number;
}

export interface GapCorrection {
  gapStartIndex: number;
  controlPoints: LatLon[];
  snappedLegs: RouteLeg[];
  snappedDistanceMeters: number;
  snappedDurationSeconds: number;
  legWeights: number[];
  generatedPoints: TrackPoint[];
}

export function parseGpx(content: string): GpxTrack {
  const xml = new DOMParser().parseFromString(content, 'application/xml');
  const parserError = xml.getElementsByTagName('parsererror').item(0);

  if (parserError) {
    throw new Error('Le fichier GPX ne peut pas etre lu.');
  }

  const metadataNode = xml.getElementsByTagNameNS('*', 'metadata').item(0);
  const metadataXml = metadataNode
    ? new XMLSerializer().serializeToString(metadataNode)
    : null;
  const trackName =
    getFirstNodeText(xml, 'trk', 'name') ??
    getFirstNodeText(xml, 'metadata', 'name') ??
    'Activite corrigee';

  const trackPointNodes = Array.from(xml.getElementsByTagNameNS('*', 'trkpt'));
  const points = trackPointNodes.map((node) => parseTrackPoint(node));

  if (points.length < 2) {
    throw new Error('Le GPX doit contenir au moins deux points de trace.');
  }

  return {
    name: trackName,
    metadataXml,
    points,
  };
}

export function computeGapCandidates(points: TrackPoint[]): GapCandidate[] {
  return points
    .slice(0, -1)
    .map((point, index) => {
      const nextPoint = points[index + 1];
      const distanceMeters = haversineDistanceMeters(point, nextPoint);
      const durationSeconds =
        point.time && nextPoint.time
          ? Math.max((nextPoint.time.getTime() - point.time.getTime()) / 1000, 0)
          : null;
      const speedKph =
        durationSeconds && durationSeconds > 0
          ? (distanceMeters / durationSeconds) * 3.6
          : null;
      const score =
        distanceMeters * Math.max(speedKph !== null ? speedKph / 22 : 1, 1);

      return {
        startIndex: index,
        endIndex: index + 1,
        distanceMeters,
        durationSeconds,
        speedKph,
        score,
      } satisfies GapCandidate;
    })
    .filter((gap) => gap.distanceMeters >= 25)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

export function createEmptyCorrection(gapStartIndex: number): GapCorrection {
  return {
    gapStartIndex,
    controlPoints: [],
    snappedLegs: [],
    snappedDistanceMeters: 0,
    snappedDurationSeconds: 0,
    legWeights: [1],
    generatedPoints: [],
  };
}

export function withGeneratedPoints(
  correction: GapCorrection,
  startPoint: TrackPoint,
  endPoint: TrackPoint,
): GapCorrection {
  if (correction.snappedLegs.length === 0) {
    return {
      ...correction,
      generatedPoints: [],
    };
  }

  const generatedPoints = generateIntermediateTrackPoints(
    startPoint,
    endPoint,
    correction.snappedLegs,
    correction.legWeights,
  );

  return {
    ...correction,
    generatedPoints,
  };
}

export function buildCorrectedTrackPoints(
  originalPoints: TrackPoint[],
  corrections: GapCorrection[],
): TrackPoint[] {
  const correctionByStartIndex = new Map(
    corrections.map((correction) => [correction.gapStartIndex, correction]),
  );

  return originalPoints.flatMap((point, index) => {
    const correction = correctionByStartIndex.get(index);
    return correction ? [point, ...correction.generatedPoints] : [point];
  });
}

export function serializeCorrectedGpx(
  track: GpxTrack,
  correctedPoints: TrackPoint[],
): string {
  const header = '<?xml version="1.0" encoding="UTF-8"?>';
  const metadataBlock = track.metadataXml ? `\n  ${track.metadataXml}` : '';
  const trackName = escapeXml(track.name);
  const trackPointsXml = correctedPoints
    .map((point) => serializeTrackPoint(point))
    .join('\n');

  return `${header}
<gpx version="1.1" creator="gpxfix" xmlns="http://www.topografix.com/GPX/1/1">
${metadataBlock}
  <trk>
    <name>${trackName}</name>
    <trkseg>
${trackPointsXml}
    </trkseg>
  </trk>
</gpx>`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || !Number.isFinite(seconds)) {
    return 'n/a';
  }

  const roundedSeconds = Math.max(0, Math.round(seconds ?? 0));
  const hours = Math.floor(roundedSeconds / 3600);
  const minutes = Math.floor((roundedSeconds % 3600) / 60);
  const remainingSeconds = roundedSeconds % 60;

  if (hours > 0) {
    return `${hours} h ${minutes.toString().padStart(2, '0')} min`;
  }

  if (minutes > 0) {
    return `${minutes} min ${remainingSeconds.toString().padStart(2, '0')} s`;
  }

  return `${remainingSeconds} s`;
}

export function formatDistance(distanceMeters: number): string {
  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(2)} km`;
  }

  return `${Math.round(distanceMeters)} m`;
}

export function haversineDistanceMeters(start: LatLon, end: LatLon): number {
  const earthRadius = 6371000;
  const latitudeDelta = toRadians(end.lat - start.lat);
  const longitudeDelta = toRadians(end.lon - start.lon);
  const startLatitude = toRadians(start.lat);
  const endLatitude = toRadians(end.lat);
  const haversineValue =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(startLatitude) *
      Math.cos(endLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(haversineValue));
}

function parseTrackPoint(node: Element): TrackPoint {
  const latitude = Number.parseFloat(node.getAttribute('lat') ?? '');
  const longitude = Number.parseFloat(node.getAttribute('lon') ?? '');

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    throw new Error('Un point GPX ne contient pas de latitude ou longitude valide.');
  }

  const elevationText = getChildText(node, 'ele');
  const timeText = getChildText(node, 'time');
  const time = timeText ? new Date(timeText) : null;

  return {
    lat: latitude,
    lon: longitude,
    ele: elevationText ? Number.parseFloat(elevationText) : null,
    time: time && !Number.isNaN(time.getTime()) ? time : null,
    source: 'original',
  };
}

function generateIntermediateTrackPoints(
  startPoint: TrackPoint,
  endPoint: TrackPoint,
  snappedLegs: RouteLeg[],
  legWeights: number[],
): TrackPoint[] {
  const fullRouteCoordinates = flattenLegCoordinates(snappedLegs);

  if (fullRouteCoordinates.length < 3) {
    return [];
  }

  const routeDistances = cumulativeDistances(fullRouteCoordinates);
  const totalDistance = routeDistances.at(-1) ?? 0;
  const totalDurationSeconds =
    startPoint.time && endPoint.time
      ? (endPoint.time.getTime() - startPoint.time.getTime()) / 1000
      : null;
  const perLegDurations = computeLegDurations(
    snappedLegs,
    legWeights,
    totalDurationSeconds,
  );
  const startTimestamp = startPoint.time?.getTime() ?? null;
  const startElevation = startPoint.ele;
  const endElevation = endPoint.ele;

  const emittedPoints: TrackPoint[] = [];
  let elapsedBeforeSeconds = 0;
  let traveledBeforeMeters = 0;

  snappedLegs.forEach((leg, legIndex) => {
    const legCoordinates = leg.coordinates;
    const legDistances = cumulativeDistances(legCoordinates);
    const legDistance = legDistances.at(-1) ?? 0;
    const legDuration = perLegDurations[legIndex] ?? 0;
    const startAt = legIndex === 0 ? 0 : 1;

    for (let coordinateIndex = startAt; coordinateIndex < legCoordinates.length; coordinateIndex += 1) {
      const coordinate = legCoordinates[coordinateIndex];
      const legDistanceAtPoint = legDistances[coordinateIndex] ?? 0;
      const legRatio =
        legDistance > 0
          ? legDistanceAtPoint / legDistance
          : coordinateIndex / Math.max(legCoordinates.length - 1, 1);
      const elapsedSeconds = elapsedBeforeSeconds + legRatio * legDuration;
      const traveledMeters = traveledBeforeMeters + legDistanceAtPoint;
      const routeRatio =
        totalDistance > 0
          ? traveledMeters / totalDistance
          : coordinateIndex / Math.max(fullRouteCoordinates.length - 1, 1);

      emittedPoints.push({
        lat: coordinate.lat,
        lon: coordinate.lon,
        ele: interpolateElevation(startElevation, endElevation, routeRatio),
        time:
          startTimestamp !== null && totalDurationSeconds !== null && totalDurationSeconds >= 0
            ? new Date(startTimestamp + elapsedSeconds * 1000)
            : null,
        source: 'generated',
      });
    }

    elapsedBeforeSeconds += legDuration;
    traveledBeforeMeters += legDistance;
  });

  return emittedPoints.slice(1, -1);
}

function flattenLegCoordinates(snappedLegs: RouteLeg[]): LatLon[] {
  return snappedLegs.flatMap((leg, index) => {
    return leg.coordinates.filter((_, coordinateIndex) => {
      return index === 0 || coordinateIndex > 0;
    });
  });
}

export function computeLegDurations(
  snappedLegs: RouteLeg[],
  legWeights: number[],
  totalDurationSeconds: number | null,
): number[] {
  if (totalDurationSeconds === null || totalDurationSeconds < 0) {
    return snappedLegs.map((leg) => leg.durationSeconds);
  }

  const weightedLegDistances = snappedLegs.map((leg, index) => {
    const weight = Math.max(legWeights[index] ?? 1, 0.05);
    const distance = Math.max(leg.distanceMeters, 1);
    return distance * weight;
  });
  const totalWeight = weightedLegDistances.reduce(
    (accumulator, value) => accumulator + value,
    0,
  );

  if (totalWeight === 0) {
    return snappedLegs.map(() => totalDurationSeconds / snappedLegs.length);
  }

  return weightedLegDistances.map((weightedDistance) => {
    return (weightedDistance / totalWeight) * totalDurationSeconds;
  });
}

function cumulativeDistances(coordinates: LatLon[]): number[] {
  const distances = [0];

  for (let index = 1; index < coordinates.length; index += 1) {
    const previousDistance = distances[index - 1] ?? 0;
    distances.push(
      previousDistance +
        haversineDistanceMeters(coordinates[index - 1], coordinates[index]),
    );
  }

  return distances;
}

function interpolateElevation(
  startElevation: number | null,
  endElevation: number | null,
  ratio: number,
): number | null {
  const normalizedRatio = Math.min(Math.max(ratio, 0), 1);

  if (startElevation !== null && endElevation !== null) {
    return startElevation + (endElevation - startElevation) * normalizedRatio;
  }

  if (startElevation !== null) {
    return startElevation;
  }

  if (endElevation !== null) {
    return endElevation;
  }

  return null;
}

function serializeTrackPoint(point: TrackPoint): string {
  const elevationNode =
    point.ele !== null ? `\n        <ele>${point.ele.toFixed(2)}</ele>` : '';
  const timeNode = point.time
    ? `\n        <time>${point.time.toISOString()}</time>`
    : '';

  return `      <trkpt lat="${point.lat.toFixed(7)}" lon="${point.lon.toFixed(7)}">${elevationNode}${timeNode}\n      </trkpt>`;
}

function getChildText(parent: Element, localName: string): string | null {
  const child = Array.from(parent.children).find(
    (candidate) => candidate.localName === localName,
  );

  return child?.textContent?.trim() ?? null;
}

function getFirstNodeText(
  document: XMLDocument,
  parentName: string,
  childName: string,
): string | null {
  const parent = document.getElementsByTagNameNS('*', parentName).item(0);

  if (!parent) {
    return null;
  }

  return getChildText(parent, childName);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}
