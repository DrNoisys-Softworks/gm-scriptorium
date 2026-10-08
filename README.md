![GM-Scriptorium: a lantern lights a page, GM notes stay dark](docs/images/banner.png)

GM-Scriptorium turns your Obsidian-style campaign vault into a website your players can read.
Before it publishes anything, it checks every page for GM notes, secrets and unrevealed names, and
leaves them out. Your notes never leave your computer. Built for tabletop GMs. Free and open source.

[Download](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases) for Windows or Linux, or
[try the sample campaign](examples/README.md).

## How it works

1. **Point it at your vault.** With no campaign yet, `gm-scriptorium serve --admin` opens setup in your browser and asks
   five questions: a name, your vault folder, where the site goes, a title and a theme.
2. **Check.** Pages are scanned for anything marked for the GM, and problems are listed by page
   before anything is built.
3. **Build and share.** You get a plain folder of web pages. Preview it in the admin panel, then
   host it anywhere.

It is one portable program with no Node or npm needed, with built-in themes and a local admin panel
that stays on your computer.

## Get it

Download the program for your system from the
[Releases page](https://github.com/DrNoisys-Softworks/gm-scriptorium/releases). The latest one is a
prerelease and is not code-signed yet, so Windows may warn you the first time you run it. Installing a
release, verifying it and building a binary are in [Install](docs/install.md).

Or build it from source (needs Node.js 22 or later):

```
git clone https://github.com/DrNoisys-Softworks/gm-scriptorium
cd gm-scriptorium && npm install
node bin/scriptorium.js --help
```

Replace `gm-scriptorium` with `node bin/scriptorium.js` in the commands below.

## Use it

Try it first on the sample campaign in [`examples/the-long-lease`](examples/README.md).

```
gm-scriptorium init
```
Set up a campaign: point it at your vault, name it and pick a theme.

```
gm-scriptorium check my-campaign
```
Read-only check of your pages, links and leaks. It writes nothing.

```
gm-scriptorium build my-campaign
```
Run the checks again and build the player site. A leak stops the build.

```
gm-scriptorium serve my-campaign
```
Preview the site on your own computer before it goes anywhere.

```
gm-scriptorium serve my-campaign --admin
```
Open the local admin panel for themes, image slots and your tagline.

## Learn more

- [Using GM-Scriptorium](docs/using.md): what a vault needs, every command, and the leak checks.
- [Install, update and build from source](docs/install.md)
- [Trying it beside a real campaign](docs/trying-it-safely.md)
- [Backing up your vault](docs/backing-up-your-vault.md)
- [Privacy](docs/privacy.md): no telemetry, no analytics, and the admin panel stays on your computer unless you turn on remote access.
- [Why, and how this relates to gm-apprentice](docs/about.md)
- [All documentation](docs/README.md)

GM-Scriptorium wraps the [gm-apprentice](https://github.com/AntTheLimey/gm-apprentice) site
generator, and all credit for the vault-to-site generation goes to that project.

## Licence and contributing

MIT. See [`LICENSE`](LICENSE). Contributions are welcome: start with
[`CONTRIBUTING.md`](CONTRIBUTING.md).
