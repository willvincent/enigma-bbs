/* jslint node: true */
'use strict';

//	ENiGMA½
const MenuModule		= require('../core/menu_module.js').MenuModule;
const ViewController	= require('../core/view_controller.js').ViewController;
const messageArea		= require('../core/message_area.js');
const stringFormat		= require('../core/string_format.js');

//	deps
const async				= require('async');
const _					= require('lodash');
const moment			= require('moment');

/*
	Available listFormat/focusListFormat members (VM1):

	msgNum			: Message number
	to				: To username/handle
	from			: From username/handle
	subj			: Subject
	ts				: Message mod timestamp (format with config.dateTimeFormat)
	newIndicator	: New mark/indicator (config.newIndicator)

	MCI codes:

	VM1			: Message list
	TL2			: Message info 1: { msgNumSelected, msgNumTotal }	
*/

exports.getModule		= MessageListModule;

exports.moduleInfo = {
	name	: 'Message List',
	desc	: 'Module for listing/browsing available messages',
	author	: 'NuSkooler',
};

const MCICodesIDs = {
	MsgList			: 1,	//	VM1
	MsgInfo1		: 2,	//	TL2
};

function MessageListModule(options) {
	MenuModule.call(this, options);

	const self		= this;
	const config	= this.menuConfig.config;

	this.messageAreaTag = config.messageAreaTag;

	if(options.extraArgs) {
		//
		//	|extraArgs| can override |messageAreaTag| provided by config
		//	as well as supply a pre-defined message list
		//
		if(options.extraArgs.messageAreaTag) {
			this.messageAreaTag = options.extraArgs.messageAreaTag;
		}

		if(options.extraArgs.messageList) {
			this.messageList = options.extraArgs.messageList;
		}
	}

	this.menuMethods = {
		selectMessage : function(formData, extraArgs, cb) {
			if(1 === formData.submitId) {
				self.initialFocusIndex = formData.value.message;

				const modOpts = {
					extraArgs 	: {
						messageAreaTag		: self.messageAreaTag,
						messageList			: self.messageList,
						messageIndex		: formData.value.message,
					}
				};

				//
				//	Provide a serializer so we don't dump *huge* bits of information to the log
				//	due to the size of |messageList|. See https://github.com/trentm/node-bunyan/issues/189
				//
				modOpts.extraArgs.toJSON = function() {
					const logMsgList = (this.messageList.length <= 4) ? 
						this.messageList : 
						this.messageList.slice(0, 2).concat(this.messageList.slice(-2)); 

					return {
						messageAreaTag		: this.messageAreaTag,
						apprevMessageList	: logMsgList,
						messageCount		: this.messageList.length,
						messageIndex		: formData.value.message,
					};
				};

				return self.gotoMenu(config.menuViewPost || 'messageAreaViewPost', modOpts, cb);
			} else {
				return cb(null);
			}
		},

		fullExit : function(formData, extraArgs, cb) {
			self.menuResult = { fullExit : true };
			return self.prevMenu(cb);
		}
	};

	this.setViewText = function(id, text) {
		const v = self.viewControllers.allViews.getView(id);
		if(v) {
			v.setText(text);
		}
	};
}

require('util').inherits(MessageListModule, MenuModule);

require('../core/mod_mixins.js').MessageAreaConfTempSwitcher.call(MessageListModule.prototype);

MessageListModule.prototype.enter = function() {
	MessageListModule.super_.prototype.enter.call(this);

	//
	//	Config can specify |messageAreaTag| else it comes from
	//	the user's current area
	//
	if(this.messageAreaTag) {
		this.tempMessageConfAndAreaSwitch(this.messageAreaTag);
	} else {
		this.messageAreaTag = this.client.user.properties.message_area_tag;
	}
};

MessageListModule.prototype.leave = function() {
	this.tempMessageConfAndAreaRestore();

	MessageListModule.super_.prototype.leave.call(this);
};

MessageListModule.prototype.mciReady = function(mciData, cb) {
	const self	= this;
	const vc	= self.viewControllers.allViews = new ViewController( { client : self.client } );

	async.series(
		[
			function callParentMciReady(callback) {
				MessageListModule.super_.prototype.mciReady.call(self, mciData, callback);
			},
			function loadFromConfig(callback) {
				const loadOpts = {
					callingMenu		: self,
					mciMap			: mciData.menu
				};

				return vc.loadFromMenuConfig(loadOpts, callback);
			},
			function fetchMessagesInArea(callback) {
				//
				//	Config can supply messages else we'll need to populate the list now
				//
				if(_.isArray(self.messageList)) {
					return callback(0 === self.messageList.length ? new Error('No messages in area') : null);
				}
				
				messageArea.getMessageListForArea( { client : self.client }, self.messageAreaTag, function msgs(err, msgList) {
					if(!msgList || 0 === msgList.length) {
						return callback(new Error('No messages in area'));
					}
					
					self.messageList = msgList;
					return callback(err);						
				});
			},
			function getLastReadMesageId(callback) {
				messageArea.getMessageAreaLastReadId(self.client.user.userId, self.messageAreaTag, function lastRead(err, lastReadId) {
					self.lastReadId = lastReadId || 0;
					return callback(null);	//	ignore any errors, e.g. missing value
				});
			},
			function updateMessageListObjects(callback) {
				const dateTimeFormat	= self.menuConfig.config.dateTimeFormat || 'ddd MMM Do';
				const newIndicator		= self.menuConfig.config.newIndicator || '*';
				const regIndicator		= new Array(newIndicator.length + 1).join(' ');	//	fill with space to avoid draw issues

				let msgNum = 1;
				self.messageList.forEach( (listItem, index) => {
					listItem.msgNum			= msgNum++;
					listItem.ts				= moment(listItem.modTimestamp).format(dateTimeFormat);
					listItem.newIndicator	= listItem.messageId > self.lastReadId ? newIndicator : regIndicator;

					if(_.isUndefined(self.initialFocusIndex) && listItem.messageId > self.lastReadId) {
						self.initialFocusIndex = index;
					}					
				});
				return callback(null);
			},
			function populateList(callback) {
				const msgListView			= vc.getView(MCICodesIDs.MsgList);	
				const listFormat			= self.menuConfig.config.listFormat || '{msgNum} - {subject} - {toUserName}';				
				const focusListFormat		= self.menuConfig.config.focusListFormat || listFormat;	//	:TODO: default change color here
				const messageInfo1Format	= self.menuConfig.config.messageInfo1Format || '{msgNumSelected} / {msgNumTotal}'; 

				//	:TODO: This can take a very long time to load large lists. What we need is to implement the "owner draw" concept in
				//	which items are requested (e.g. their format at least) *as-needed* vs trying to get the format for all of them at once

				msgListView.setItems(_.map(self.messageList, listEntry => {
					return stringFormat(listFormat, listEntry);
				}));

				msgListView.setFocusItems(_.map(self.messageList, listEntry => {
					return stringFormat(focusListFormat, listEntry);
				}));

				msgListView.on('index update', idx => {
					self.setViewText(
						MCICodesIDs.MsgInfo1, 
						stringFormat(messageInfo1Format, { msgNumSelected : (idx + 1), msgNumTotal : self.messageList.length } ));
				});
				
				if(self.initialFocusIndex > 0) {
					//	note: causes redraw()
					msgListView.setFocusItemIndex(self.initialFocusIndex);
				} else {
					msgListView.redraw();
				}

				return callback(null);
			},
			function drawOtherViews(callback) {
				const messageInfo1Format = self.menuConfig.config.messageInfo1Format || '{msgNumSelected} / {msgNumTotal}';
				self.setViewText(
					MCICodesIDs.MsgInfo1, 
					stringFormat(messageInfo1Format, { msgNumSelected : self.initialFocusIndex + 1, msgNumTotal : self.messageList.length } ));
				return callback(null);
			},
		],		
		err => {
			if(err) {
				self.client.log.error( { error : err.message }, 'Error loading message list');				
			}
			return cb(err);
		}
	);
};

MessageListModule.prototype.getSaveState = function() {
	return { initialFocusIndex : this.initialFocusIndex };
};

MessageListModule.prototype.restoreSavedState = function(savedState) {
	if(savedState) {
		this.initialFocusIndex = savedState.initialFocusIndex;
	}
};

MessageListModule.prototype.getMenuResult = function() {
	return this.menuResult;	
};
