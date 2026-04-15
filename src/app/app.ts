import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  signal,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';

import {
  type GapCandidate,
  type GapCorrection,
  type GpxTrack,
  type LatLon,
  type RouteLeg,
  type TrackPoint,
  buildCorrectedTrackPoints,
  computeGapCandidates,
  computeLegDurations,
  createEmptyCorrection,
  formatDistance,
  formatDuration,
  parseGpx,
  serializeCorrectedGpx,
  withGeneratedPoints,
} from './gpx-domain';

type RouteProfile = 'cycling' | 'walking' | 'driving';

interface OsrmStepResponse {
  geometry?: {
    coordinates: [number, number][];
  };
}

interface OsrmLegResponse {
  distance: number;
  duration: number;
  steps: OsrmStepResponse[];
}

interface OsrmRouteResponse {
  code: string;
  routes?: Array<{
    distance: number;
    duration: number;
    legs: OsrmLegResponse[];
  }>;
}

@Component({
  selector: 'app-root',
  imports: [],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'app-shell',
  },
})
export class App implements AfterViewInit {
  protected readonly fileInputRef = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  protected readonly mapHostRef = viewChild.required<ElementRef<HTMLElement>>('mapHost');

  protected readonly track = signal<GpxTrack | null>(null);
  protected readonly corrections = signal<Record<number, GapCorrection>>({});
  protected readonly selectedGapStartIndex = signal<number | null>(null);
  protected readonly activeRouteProfile = signal<RouteProfile>('cycling');
  protected readonly addWaypointMode = signal(false);
  protected readonly dropActive = signal(false);
  protected readonly loadingRoute = signal(false);
  protected readonly statusMessage = signal(
    'Importez un GPX, selectionnez un saut suspect, puis replacez le segment sur la route.',
  );
  protected readonly errorMessage = signal<string | null>(null);
  protected readonly sourceFileName = signal<string>('');

  protected readonly gapCandidates = computed(() => {
    const track = this.track();
    return track ? computeGapCandidates(track.points) : [];
  });
  protected readonly selectedGap = computed(() => {
    const gapStartIndex = this.selectedGapStartIndex();

    if (gapStartIndex === null) {
      return null;
    }

    return (
      this.gapCandidates().find((gap) => gap.startIndex === gapStartIndex) ?? null
    );
  });
  protected readonly selectedCorrection = computed(() => {
    const gapStartIndex = this.selectedGapStartIndex();

    if (gapStartIndex === null) {
      return null;
    }

    return this.corrections()[gapStartIndex] ?? null;
  });
  protected readonly correctedPoints = computed(() => {
    const track = this.track();

    if (!track) {
      return [];
    }

    return buildCorrectedTrackPoints(track.points, this.sortedCorrections());
  });
  protected readonly selectedLegDurations = computed(() => {
    const gap = this.selectedGap();
    const correction = this.selectedCorrection();
    const track = this.track();

    if (!gap || !correction || !track) {
      return [];
    }

    const startPoint = track.points[gap.startIndex];
    const endPoint = track.points[gap.endIndex];
    const totalDurationSeconds =
      startPoint.time && endPoint.time
        ? (endPoint.time.getTime() - startPoint.time.getTime()) / 1000
        : null;

    return computeLegDurations(
      correction.snappedLegs,
      correction.legWeights,
      totalDurationSeconds,
    );
  });
  protected readonly hasUsableTrack = computed(() => this.track() !== null);
  protected readonly hasCorrections = computed(() => this.sortedCorrections().length > 0);

  private map: L.Map | null = null;
  private overlayLayer = L.layerGroup();
  private hasFittedTrack = false;
  private readonly timeFormatter = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  constructor() {
    effect(() => {
      this.track();
      this.corrections();
      this.selectedGapStartIndex();
      queueMicrotask(() => this.refreshMap());
    });

    effect(() => {
      const container = this.map?.getContainer();
      if (!container) {
        return;
      }

      container.classList.toggle('map-adding', this.addWaypointMode());
    });
  }

  ngAfterViewInit(): void {
    this.initializeMap(this.mapHostRef().nativeElement);
  }

  protected async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.item(0);

    input.value = '';

    if (!file) {
      return;
    }

    await this.loadTrackFile(file);
  }

  protected async onFileDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dropActive.set(false);
    const file = event.dataTransfer?.files.item(0);

    if (!file) {
      return;
    }

    await this.loadTrackFile(file);
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dropActive.set(true);
  }

  protected onDragLeave(): void {
    this.dropActive.set(false);
  }

  protected openFilePicker(): void {
    this.fileInputRef().nativeElement.click();
  }

  protected async selectGap(gap: GapCandidate): Promise<void> {
    this.errorMessage.set(null);
    this.addWaypointMode.set(false);
    this.selectedGapStartIndex.set(gap.startIndex);
    this.ensureCorrection(gap.startIndex);
    this.fitSelectedGap();

    const existingCorrection = this.corrections()[gap.startIndex];
    if (!existingCorrection || existingCorrection.snappedLegs.length === 0) {
      await this.recomputeRoute(gap.startIndex);
    }
  }

  protected async changeRouteProfile(event: Event): Promise<void> {
    const routeProfile = (event.target as HTMLSelectElement).value as RouteProfile;
    this.activeRouteProfile.set(routeProfile);

    const gapStartIndex = this.selectedGapStartIndex();
    if (gapStartIndex !== null) {
      await this.recomputeRoute(gapStartIndex);
    }
  }

  protected toggleWaypointMode(): void {
    this.addWaypointMode.update((value) => !value);
  }

  protected async removeWaypoint(index: number): Promise<void> {
    const gapStartIndex = this.selectedGapStartIndex();

    if (gapStartIndex === null) {
      return;
    }

    this.updateCorrection(gapStartIndex, (correction) => ({
      ...correction,
      controlPoints: correction.controlPoints.filter((_, currentIndex) => currentIndex !== index),
    }));
    await this.recomputeRoute(gapStartIndex);
  }

  protected async resetCurrentCorrection(): Promise<void> {
    const gapStartIndex = this.selectedGapStartIndex();

    if (gapStartIndex === null) {
      return;
    }

    this.corrections.update((current) => ({
      ...current,
      [gapStartIndex]: createEmptyCorrection(gapStartIndex),
    }));
    await this.recomputeRoute(gapStartIndex);
  }

  protected updateLegWeight(index: number, event: Event): void {
    const gap = this.selectedGap();
    const track = this.track();
    const gapStartIndex = this.selectedGapStartIndex();

    if (!gap || !track || gapStartIndex === null) {
      return;
    }

    const nextWeight = Number.parseFloat((event.target as HTMLInputElement).value);
    const safeWeight = Number.isFinite(nextWeight) ? Math.max(nextWeight, 0.1) : 1;
    const startPoint = track.points[gap.startIndex];
    const endPoint = track.points[gap.endIndex];

    this.updateCorrection(gapStartIndex, (correction) => {
      const nextWeights = correction.legWeights.map((weight, legIndex) => {
        return legIndex === index ? safeWeight : weight;
      });

      return withGeneratedPoints(
        {
          ...correction,
          legWeights: nextWeights,
        },
        startPoint,
        endPoint,
      );
    });
  }

  protected exportCorrectedTrack(): void {
    const track = this.track();

    if (!track) {
      return;
    }

    const correctedPoints = this.correctedPoints();
    const xml = serializeCorrectedGpx(track, correctedPoints);
    const blob = new Blob([xml], { type: 'application/gpx+xml;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = downloadUrl;
    anchor.download = `${this.safeFileStem()}.corrected.gpx`;
    anchor.click();
    URL.revokeObjectURL(downloadUrl);
  }

  protected zoomToTrack(): void {
    const track = this.track();

    if (!track) {
      return;
    }

    this.fitCoordinates(track.points);
  }

  protected zoomToSelection(): void {
    this.fitSelectedGap();
  }

  protected formatDistance(value: number): string {
    return formatDistance(value);
  }

  protected formatDuration(value: number | null): string {
    return formatDuration(value);
  }

  protected formatTime(value: Date | null): string {
    return value ? this.timeFormatter.format(value) : 'n/a';
  }

  protected segmentLabel(gap: GapCandidate): string {
    return `Points ${gap.startIndex + 1} -> ${gap.endIndex + 1}`;
  }

  private async loadTrackFile(file: File): Promise<void> {
    this.errorMessage.set(null);
    this.statusMessage.set('Lecture du fichier GPX...');

    try {
      const parsedTrack = parseGpx(await file.text());
      this.track.set(parsedTrack);
      this.corrections.set({});
      this.sourceFileName.set(file.name.replace(/\.gpx$/i, ''));
      this.selectedGapStartIndex.set(null);
      this.hasFittedTrack = false;
      this.statusMessage.set(
        `${parsedTrack.points.length} points importes. Selectionnez un saut a corriger dans la liste.`,
      );

      const firstGap = computeGapCandidates(parsedTrack.points)[0] ?? null;
      if (firstGap) {
        await this.selectGap(firstGap);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Le GPX ne peut pas etre importe.';
      this.track.set(null);
      this.corrections.set({});
      this.selectedGapStartIndex.set(null);
      this.errorMessage.set(message);
      this.statusMessage.set('Import impossible.');
    }
  }

  private initializeMap(mapHost: HTMLElement): void {
    this.map = L.map(mapHost, {
      zoomControl: true,
      preferCanvas: true,
    }).setView([46.6, 2.4], 6);
    this.overlayLayer.addTo(this.map);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    this.map.on('click', (event: L.LeafletMouseEvent) => {
      if (!this.addWaypointMode() || this.selectedGapStartIndex() === null) {
        return;
      }

      void this.addWaypoint(event.latlng);
    });
  }

  private refreshMap(): void {
    if (!this.map) {
      return;
    }

    this.overlayLayer.clearLayers();
    const track = this.track();

    if (!track) {
      return;
    }

    const correctedPoints = this.correctedPoints();
    L.polyline(this.toLatLngTuples(track.points), {
      color: '#5e7285',
      weight: 4,
      opacity: 0.35,
    }).addTo(this.overlayLayer);

    if (correctedPoints.length > 1) {
      L.polyline(this.toLatLngTuples(correctedPoints), {
        color: '#ef6c00',
        weight: 5,
        opacity: 0.92,
      }).addTo(this.overlayLayer);
    }

    const gap = this.selectedGap();
    const correction = this.selectedCorrection();

    if (gap) {
      const startPoint = track.points[gap.startIndex];
      const endPoint = track.points[gap.endIndex];

      L.polyline(this.toLatLngTuples([startPoint, endPoint]), {
        color: '#1f2937',
        weight: 2,
        dashArray: '10 8',
        opacity: 0.7,
      }).addTo(this.overlayLayer);

      L.circleMarker([startPoint.lat, startPoint.lon], {
        radius: 8,
        color: '#10454f',
        weight: 2,
        fillColor: '#0ea5a5',
        fillOpacity: 0.95,
      })
        .bindTooltip('Debut du segment')
        .addTo(this.overlayLayer);

      L.circleMarker([endPoint.lat, endPoint.lon], {
        radius: 8,
        color: '#7c2d12',
        weight: 2,
        fillColor: '#fb923c',
        fillOpacity: 0.95,
      })
        .bindTooltip('Fin du segment')
        .addTo(this.overlayLayer);

      if (correction?.snappedLegs.length) {
        const snappedCoordinates = correction.snappedLegs.flatMap((leg, legIndex) => {
          return leg.coordinates.filter((_, coordinateIndex) => {
            return legIndex === 0 || coordinateIndex > 0;
          });
        });

        L.polyline(this.toLatLngTuples(snappedCoordinates), {
          color: '#b45309',
          weight: 6,
          opacity: 0.9,
        }).addTo(this.overlayLayer);
      }

      correction?.controlPoints.forEach((controlPoint, index) => {
        L.marker([controlPoint.lat, controlPoint.lon], {
          draggable: true,
          icon: this.createControlPointIcon(index + 1),
          keyboard: true,
        })
          .on('dragend', (event: L.DragEndEvent) => {
            const marker = event.target as L.Marker;
            void this.moveWaypoint(index, marker.getLatLng());
          })
          .bindTooltip(`Point intermediaire ${index + 1}`)
          .addTo(this.overlayLayer);
      });
    }

    if (!this.hasFittedTrack) {
      this.fitCoordinates(correctedPoints.length > 1 ? correctedPoints : track.points);
      this.hasFittedTrack = true;
    }
  }

  private async addWaypoint(latLng: L.LatLng): Promise<void> {
    const gapStartIndex = this.selectedGapStartIndex();

    if (gapStartIndex === null) {
      return;
    }

    this.updateCorrection(gapStartIndex, (correction) => ({
      ...correction,
      controlPoints: [...correction.controlPoints, { lat: latLng.lat, lon: latLng.lng }],
    }));
    await this.recomputeRoute(gapStartIndex);
  }

  private async moveWaypoint(index: number, latLng: L.LatLng): Promise<void> {
    const gapStartIndex = this.selectedGapStartIndex();

    if (gapStartIndex === null) {
      return;
    }

    this.updateCorrection(gapStartIndex, (correction) => ({
      ...correction,
      controlPoints: correction.controlPoints.map((point, currentIndex) => {
        return currentIndex === index ? { lat: latLng.lat, lon: latLng.lng } : point;
      }),
    }));
    await this.recomputeRoute(gapStartIndex);
  }

  private async recomputeRoute(gapStartIndex: number): Promise<void> {
    const track = this.track();

    if (!track) {
      return;
    }

    const gap = computeGapCandidates(track.points).find(
      (candidate) => candidate.startIndex === gapStartIndex,
    );
    const correction = this.corrections()[gapStartIndex] ?? createEmptyCorrection(gapStartIndex);

    if (!gap) {
      return;
    }

    const startPoint = track.points[gap.startIndex];
    const endPoint = track.points[gap.endIndex];
    const waypoints = [startPoint, ...correction.controlPoints, endPoint];

    this.loadingRoute.set(true);
    this.errorMessage.set(null);
    this.statusMessage.set('Recalcul de l\'itineraire corrige...');

    try {
      const route = await this.fetchRoute(waypoints, this.activeRouteProfile());
      const normalizedWeights = this.normalizeLegWeights(
        correction.legWeights,
        route.legs.length,
      );

      this.updateCorrection(gapStartIndex, () => {
        return withGeneratedPoints(
          {
            ...correction,
            snappedLegs: route.legs,
            snappedDistanceMeters: route.distanceMeters,
            snappedDurationSeconds: route.durationSeconds,
            legWeights: normalizedWeights,
          },
          startPoint,
          endPoint,
        );
      });
      this.statusMessage.set('Segment corrige. Ajustez les poids temporels puis exportez le GPX.');
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Le calcul de route a echoue.';
      this.errorMessage.set(message);
      this.statusMessage.set('Impossible de recalculer ce segment.');
    } finally {
      this.loadingRoute.set(false);
    }
  }

  private async fetchRoute(
    waypoints: LatLon[],
    routeProfile: RouteProfile,
  ): Promise<{ distanceMeters: number; durationSeconds: number; legs: RouteLeg[] }> {
    const serializedWaypoints = waypoints
      .map((waypoint) => `${waypoint.lon},${waypoint.lat}`)
      .join(';');
    const response = await fetch(
      `https://router.project-osrm.org/route/v1/${routeProfile}/${serializedWaypoints}?steps=true&overview=full&geometries=geojson`,
    );

    if (!response.ok) {
      throw new Error('Le service de routage externe n\'est pas disponible.');
    }

    const payload = (await response.json()) as OsrmRouteResponse;
    const route = payload.routes?.[0];

    if (payload.code !== 'Ok' || !route) {
      throw new Error('Aucune route n\'a ete trouvee pour ce segment.');
    }

    const legs = route.legs.map((leg, index) => {
      const fallbackStart = waypoints[index] ?? waypoints[0];
      const fallbackEnd = waypoints[index + 1] ?? waypoints.at(-1) ?? waypoints[0];
      const coordinates = this.extractLegCoordinates(leg, fallbackStart, fallbackEnd);

      return {
        coordinates,
        distanceMeters: leg.distance,
        durationSeconds: leg.duration,
      } satisfies RouteLeg;
    });

    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      legs,
    };
  }

  private extractLegCoordinates(
    leg: OsrmLegResponse,
    fallbackStart: LatLon,
    fallbackEnd: LatLon,
  ): LatLon[] {
    const coordinates = leg.steps.flatMap((step: OsrmStepResponse, stepIndex: number) => {
      const stepCoordinates = step.geometry?.coordinates ?? [];

      return stepCoordinates
        .map(([lon, lat]: [number, number]) => ({ lat, lon }))
        .filter((_: LatLon, coordinateIndex: number) => stepIndex === 0 || coordinateIndex > 0);
    });

    if (coordinates.length >= 2) {
      return coordinates;
    }

    return [fallbackStart, fallbackEnd];
  }

  private ensureCorrection(gapStartIndex: number): void {
    this.corrections.update((current) => {
      return current[gapStartIndex]
        ? current
        : {
            ...current,
            [gapStartIndex]: createEmptyCorrection(gapStartIndex),
          };
    });
  }

  private updateCorrection(
    gapStartIndex: number,
    updater: (correction: GapCorrection) => GapCorrection,
  ): void {
    this.corrections.update((current) => {
      const currentCorrection = current[gapStartIndex] ?? createEmptyCorrection(gapStartIndex);

      return {
        ...current,
        [gapStartIndex]: updater(currentCorrection),
      };
    });
  }

  private normalizeLegWeights(weights: number[], expectedLength: number): number[] {
    return Array.from({ length: expectedLength }, (_, index) => weights[index] ?? 1);
  }

  private fitSelectedGap(): void {
    const track = this.track();
    const gap = this.selectedGap();

    if (!track || !gap) {
      return;
    }

    const correction = this.corrections()[gap.startIndex];
    const focusPoints = correction?.snappedLegs.length
      ? correction.snappedLegs.flatMap((leg, legIndex) => {
          return leg.coordinates.filter((_, coordinateIndex) => {
            return legIndex === 0 || coordinateIndex > 0;
          });
        })
      : [track.points[gap.startIndex], ...correction?.controlPoints ?? [], track.points[gap.endIndex]];

    this.fitCoordinates(focusPoints, 16);
  }

  private fitCoordinates(points: LatLon[], maxZoom = 15): void {
    if (!this.map || points.length < 2) {
      return;
    }

    const bounds = L.latLngBounds(this.toLatLngTuples(points));
    this.map.fitBounds(bounds.pad(0.2), { maxZoom });
  }

  private toLatLngTuples(points: LatLon[]): L.LatLngTuple[] {
    return points.map((point) => [point.lat, point.lon]);
  }

  private sortedCorrections(): GapCorrection[] {
    return Object.values(this.corrections()).sort(
      (left, right) => left.gapStartIndex - right.gapStartIndex,
    );
  }

  private createControlPointIcon(order: number): L.DivIcon {
    return L.divIcon({
      className: 'control-point-marker',
      html: `<span style="display:grid;place-items:center;width:28px;height:28px;border-radius:999px;border:2px solid #0f172a;background:#f7b267;color:#0f172a;font:700 12px/1 ui-sans-serif,system-ui,sans-serif;box-shadow:0 10px 18px rgba(15,23,42,0.2);">${order}</span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
  }

  private safeFileStem(): string {
    return this.sourceFileName() || 'activity';
  }
}
