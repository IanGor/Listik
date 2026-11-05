const { packager } = require('@electron/packager');
void packager({ dir: __dirname, name: 'Listik', platform: 'linux', arch: process.env.LISTIK_PACKAGE_ARCH ?? process.arch, out: 'dist', overwrite: true, ignore: /^\/(tests|packaging|dist)(\/|$)/ }).catch(error => { console.error(error); process.exitCode = 1; });
