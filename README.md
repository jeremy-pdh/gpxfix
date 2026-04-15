# Gpxfix

Vibe coded project to fix .gpx files for use in Strava. The project is built using Angular and provides a user-friendly interface for uploading and fixing .gpx files.

🇫🇷 Initial prompt (I'm switching QWERTY...):

```
Je veux que tu implementes une appli web ou je peux importer un fichier .gpx et le corriger quand j'ai mis pause pendant une activite et roublie de resume.
Donc le but serait de fixer le gpx importe en remettant les points gps sur la route donc il me faut un fond de carte je veux drag and drop ou cliquer sur la carte pour ajouter des points intermediares pour corriger mon gpx
Je veux aussi pouvoir regler finement le temps de ces nouveaux points gpx creer pendant que le record etait en pause car si jetais en montee a velo c'est plus lent aue la descente donc il me faut la feature d'interpolation de temps a l'endroit ou je fix le gpx lineaire par defaut mais reglable par la suite
Si tu peux tout faire avec une seule page web static sans client server architecture c'est prefereable
J'ai une preference si tu utilises angular avec un setup minimal
```


## Development server

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 21.2.3.

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
