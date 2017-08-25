/* jslint node: true */
'use strict';

//	deps
const fs			= require('graceful-fs');
const iconv			= require('iconv-lite');
const async			= require('async');

module.exports = class DescriptIonFile {
	constructor() {
		this.entries = new Map();
	}

	get(fileName) {
		return this.entries.get(fileName);
	}

	getDescription(fileName) {
		const entry = this.get(fileName);
		if(entry) {
			return entry.desc;
		}
	}

	static createFromFile(path, cb) {
		fs.readFile(path, (err, descData) => {
			if(err) {
				return cb(err);
			}

			const descIonFile = new DescriptIonFile();

			//	DESCRIPT.ION entries are terminated with a CR and/or LF
			const lines = iconv.decode(descData, 'cp437').split(/\r?\n/g);

			async.each(lines, (entryData, nextLine) => {
				//
				//	We allow quoted (long) filenames or non-quoted filenames.
				//	FILENAME<SPC>DESC<0x04><program data><CR/LF>
				//
				const parts = entryData.match(/^(?:(?:"([^"]+)" )|(?:([^ ]+) ))([^\x04]+)\x04(.)[^\r\n]*$/);	//	eslint-disable-line no-control-regex
				if(!parts) {
					return nextLine(null);
				}

				const fileName	= parts[1] || parts[2];
				const desc		= parts[3].replace(/\\r\\n|\\n/g, '\r\n');	//	un-escape CR/LF's

				descIonFile.entries.set(
					fileName,
					{
						desc		: desc,
						programId	: parts[4],
						programData	: parts[5],
					}
				);

				return nextLine(null);
			},
			() => {
				return cb(null, descIonFile);
			});
		});
	}
};

