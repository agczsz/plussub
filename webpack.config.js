// webpack.config.js
/* eslint @typescript-eslint/no-var-requires: "off" */
import {resolve} from 'path';
import {readFileSync} from 'fs';
import { VueLoaderPlugin } from 'vue-loader';
import CopyPlugin from 'copy-webpack-plugin';
import webpack from 'webpack';

const setObject = (object, key, value) => ({
  ...object,
  [key]: value,
});

const whenSetObject = (predicate, object, key, value) => (predicate() ? setObject(object, key, value) : { ...object });

const toPrettyJson = (obj) => JSON.stringify(obj, null, 2);

const EXTENSION_ORIGIN = "plussub";

const FIREFOX_EXTENSION_KEY = '{83078104-a00b-45e2-8749-7a10af244653}'

export default (env) => {
  const browser = (env.browser ? env.browser.toLowerCase() : 'unknown').trim();
  if (browser !== 'chrome' && browser !== 'firefox') {
    throw new Error(`unknown browser: ${browser}`);
  }
  const mode = (env.mode ?? 'development').trim();

  return {
    devtool: false,
    mode,
    entry: { popup: './popup/index.ts', background: './background/index.ts', contentScript: './contentScript/index.ts' },
    context: resolve('src'),
    output: {
      filename: '[name].js',
      path: resolve(`dist-${browser}`)
    },
    resolve: {
      extensions: ['.ts', '.js', '.vue', '.json', '.mjs'],
      alias: {
        '@': resolve('src/popup'),
        storeTypes: resolve(`src/popup/storeTypes/index.ts`),
        storage: resolve(`src/popup/platform/storage/${browser}/index.ts`),
        "SnapToLinesHint.vue": resolve(`src/popup/appearance/components/platform/${browser}/SnapToLinesHint.vue`),
        monkeyPatchApollo: resolve(`src/popup/platform/monkeyPatchApollo/${browser}/index.ts`),
        onPageActionClicked: resolve(`src/background/platform/onPageActionClicked/${browser}/index.ts`)
      }
    },
    module: {
      rules: [
        {
          test: /\.vue$/,
          loader: 'vue-loader'
        },
        {
          test: /\.css$/,
          use: [
            {
              loader: 'style-loader',
              options: { injectType: 'singletonStyleTag', attributes: { id: `${EXTENSION_ORIGIN}-style` } }
            },
            'css-loader',
            'postcss-loader'
          ]
        },
        {
          test: /\.(png|jpe?g|gif|svg)$/i,
          use: [
            // {
            //   loader: 'file-loader',
            // },
            {
              loader: 'url-loader',
              options: {
                limit: 102400
              }
            }
          ]
        },
        {
          test: /\.(woff|woff2|ttf|eot)$/,
          use: 'file-loader?name=fonts/[name].[ext]!static'
        },
        {
          test: /\.tsx?$/,
          loader: 'ts-loader',
          exclude: /node_modules/,
          options: {
            appendTsSuffixTo: [/\.vue$/]
          }
        },
        {
          test: /\.html$/i,
          loader: 'html-loader'
        },
        {
          test: /\.(graphql|gql)$/,
          exclude: /node_modules/,
          loader: 'graphql-tag/loader'
        },
        {
          test: /\.mjs$/,
          include: /node_modules/,
          type: 'javascript/auto',
          resolve: {
            fullySpecified: false
          }
        }
      ]
    },
    optimization: {},
    plugins: [
      new VueLoaderPlugin(),
      new CopyPlugin({
        patterns: [
          {
            from: `manifest-${browser}.json`,
            to: 'manifest.json',
            transform: (manifest) => {
              const withVersion = setObject(JSON.parse(manifest.toString()),
                'version',
                JSON.parse(readFileSync(resolve('package.json'))).version)

              const mayWithExtensionId  = whenSetObject(() => browser === 'firefox' && mode !== "production" , withVersion , 'browser_specific_settings', {
                gecko: {
                  id: FIREFOX_EXTENSION_KEY,
                  "strict_min_version": "42.0"
                }
              });

              return toPrettyJson(mayWithExtensionId);
            }
          },
          { from: 'res', to: 'res', globOptions: { ignore: ['**/fonts/**'] } },
          { from: '../node_modules/libass-wasm/dist/js/subtitles-octopus-worker.js', to: 'libass-wasm/subtitles-octopus-worker.js' },
          { from: '../node_modules/libass-wasm/dist/js/subtitles-octopus-worker-legacy.js', to: 'libass-wasm/subtitles-octopus-worker-legacy.js' },
          { from: '../node_modules/libass-wasm/dist/js/subtitles-octopus-worker.wasm', to: 'libass-wasm/subtitles-octopus-worker.wasm' },
          { from: '../node_modules/typeface-roboto/files/roboto-latin-400.woff2', to: 'fonts/roboto-latin-400.woff2' },
          { from: 'res/fonts/msyh.ttc', to: 'fonts/msyh.ttc' },
          { from: 'res/fonts/msyhbd.ttc', to: 'fonts/msyhbd.ttc' },
          { from: 'popup/font.css', to: 'font.css' },
          { from: 'contentScript/contentScript.css', to: 'contentScript.css' },
          { from: 'cssContentScript/index.js', to: 'cssContentScript.js' }
        ]
      }),
      new webpack.DefinePlugin({
        __VUE_PROD_DEVTOOLS__: 'false'
      })
    ]
  };
};
