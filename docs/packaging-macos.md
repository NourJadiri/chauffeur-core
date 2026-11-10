# Packaging for macOS

`scripts/package.sh` builds `target/release/Chauffeur-<version>.dmg` and its `.sha256`, signed ad
hoc. This does not provide Developer ID signing or Apple notarization. The image opens on a window of its own
(Chauffeur's icon on the disk, the app and Applications on a background, an arrow between them),
laid out by [dmgbuild](https://github.com/dmgbuild/dmgbuild) without driving the Finder: the build
needs Python 3.10 or later and installs dmgbuild's pinned version into `target/dmgbuild`. The
background's source and how to render it again are in [scripts/dmg/](../scripts/dmg/background.svg). To sign it with your Developer ID instead,
and have Apple notarize it so that it opens without a warning, give the build an identity of your
keychain and an App Store Connect API key:

```sh
CHAUFFEUR_CODESIGN_IDENTITY="Developer ID Application: <name> (<team id>)" \
CHAUFFEUR_NOTARY_KEY=<path to AuthKey_<key id>.p8> CHAUFFEUR_NOTARY_KEY_ID=<key id> \
CHAUFFEUR_NOTARY_ISSUER=<issuer id> scripts/package.sh
```

Without the `CHAUFFEUR_NOTARY_*` values the image is signed but not notarized
([scripts/sign-macos.sh](../scripts/sign-macos.sh), [decision](adr/developer-id-signing-and-notarization.md)).
