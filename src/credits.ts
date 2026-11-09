// Data sources, services and software used by the app, with the attribution and licence notices
// they require. Rendered on the phone page ("Data sources & licences").
// When adding a network (see networks/index.ts), add its provider and data licences here too.

import sdkLicence from '../node_modules/@evenrealities/even_hub_sdk/LICENSE?raw'

export interface Credit {
  name: string
  url: string
  /** What the app uses it for. */
  usedFor: string
  licence: string
  licenceUrl?: string
  /** Attribution / notice text as required by the licence or terms. */
  notice?: string
  /** Full licence text, where the licence asks for it to be included with copies. */
  fullText?: string
}

export interface CreditGroup {
  title: string
  items: Credit[]
}

const MIT = (copyright: string) => `MIT License

${copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

const APP_LICENCE = MIT('Copyright (c) 2026 Dominik Fahrni')

export const CREDITS: CreditGroup[] = [
  {
    title: 'This app',
    items: [
      {
        name: 'Simple transit',
        url: 'https://opensource.org/license/mit',
        usedFor: 'Source code of this app. Data and third-party software below keep their own licences.',
        licence: 'MIT License',
        fullText: APP_LICENCE,
      },
    ],
  },
  {
    title: 'Timetable data',
    items: [
      {
        name: 'opentransportdata.swiss',
        url: 'https://opentransportdata.swiss',
        usedFor: 'Swiss timetable and real-time data (stops, departures, connections, delays, platforms), received through transport.opendata.ch.',
        licence: 'opentransportdata.swiss terms of use',
        licenceUrl: 'https://opentransportdata.swiss/en/terms-of-use/',
        notice: 'Source: opentransportdata.swiss. The data is processed (filtered, shortened and combined for display) by Simple transit.',
      },
      {
        name: 'DELFI e.V. (opendata-oepnv.de)',
        url: 'https://www.opendata-oepnv.de',
        usedFor: 'Nationwide German timetable data, received through Transitous.',
        licence: 'CC BY 4.0',
        licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
        notice: 'Contains data of DELFI e.V., licensed under CC BY 4.0. Changes: converted and combined with other sources by Transitous, filtered and shortened for display by Simple transit.',
      },
      {
        name: 'Further sources via Transitous',
        url: 'https://transitous.org/sources/',
        usedFor: 'Regional, national and real-time feeds in many countries (each with its own licence, listed on the Transitous sources page).',
        licence: 'Various (listed per source)',
        licenceUrl: 'https://transitous.org/sources/',
      },
    ],
  },
  {
    title: 'Services',
    items: [
      {
        name: 'Transport API (transport.opendata.ch)',
        url: 'https://transport.opendata.ch',
        usedFor: 'Fallback in Switzerland and for trains across the border: stops near you, departures, connections and search.',
        licence: 'MIT License (software), © 2012–2026 Opendata.ch',
        licenceUrl: 'https://transport.opendata.ch/licenses.html',
        notice: 'Unofficial API, powered by Opendata.ch.',
      },
      {
        name: 'Transitous',
        url: 'https://transitous.org',
        usedFor: 'Preferred network: stops near you, departures, connections and search; street map tiles for the departure board map (all countries).',
        licence: 'Transitous usage policy',
        licenceUrl: 'https://transitous.org/api/',
        notice: 'Community-run, free service for non-commercial use. Data sources: transitous.org/sources.',
      },
      {
        name: 'MOTIS',
        url: 'https://github.com/motis-project/motis',
        usedFor: 'Journey planner software behind Transitous and the Transport API.',
        licence: 'MIT License',
        licenceUrl: 'https://github.com/motis-project/motis/blob/master/LICENSE',
      },
    ],
  },
  {
    title: 'Map data',
    items: [
      {
        name: 'OpenStreetMap',
        url: 'https://www.openstreetmap.org',
        usedFor: 'Streets on the departure board map, addresses and places in the search, walking routes.',
        licence: 'Open Database License (ODbL) 1.0',
        licenceUrl: 'https://www.openstreetmap.org/copyright',
        notice: '© OpenStreetMap contributors',
      },
    ],
  },
  {
    title: 'Software included in the app',
    items: [
      {
        name: 'Even Hub SDK (@evenrealities/even_hub_sdk 0.0.16)',
        url: 'https://www.npmjs.com/package/@evenrealities/even_hub_sdk',
        usedFor: 'Connection to the Even Realities app and glasses.',
        licence: 'MIT License',
        fullText: sdkLicence.trim(),
      },
      {
        name: 'Vite',
        url: 'https://vite.dev',
        usedFor: 'Build tool; a small module-loading helper from Vite is part of the app bundle.',
        licence: 'MIT License',
        fullText: MIT('Copyright (c) 2019-present, VoidZero Inc. and Vite contributors'),
      },
    ],
  },
]
