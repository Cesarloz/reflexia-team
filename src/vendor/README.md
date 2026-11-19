# Exportación Word

`docx.mjs` es el bundle ESM completo de **docx 9.6.1**, copiado sin cambios desde el runtime de dependencias de Codex. Funciona en el navegador y no descarga código externo. Su licencia MIT está en `docx.LICENSE`; las licencias de las dependencias incorporadas se conservan en `THIRD_PARTY_LICENSES.txt`.

- Proyecto y documentación: https://docx.js.org/
- Código fuente: https://github.com/dolanmiu/docx
- Paquete: https://www.npmjs.com/package/docx/v/9.6.1

El módulo `../report.js` usa `Packer.toBlob` para generar un archivo ZIP OOXML real, editable en Word. No se renombra HTML como `.docx`.

Para actualizar, reemplazar el bundle por la distribución ESM oficial y revisar sus licencias; después ejecutar `node --test tests/report.test.mjs` desde la raíz del proyecto y probar una descarga en el navegador.
