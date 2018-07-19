#!/bin/sh
set -e

rm -rf lambda-package lambda-package.zip
mkdir lambda-package
cp -a handler-lambda.js node_modules package.json lambda-package
cd lambda-package && zip -q -r ../lambda-package.zip *
