/* jslint node: true */
/* eslint-disable no-console */
'use strict';

const {
    printUsageAndSetExitCode,
    getAnswers,
    ExitCodes,
    argv,
    initConfigAndDatabases
}                               = require('./oputil_common.js');
const getHelpFor				= require('./oputil_help.js').getHelpFor;
const Errors					= require('../enig_error.js').Errors;
const UserProps                 = require('../user_property.js');

const async						= require('async');
const _							= require('lodash');
const moment                    = require('moment');

exports.handleUserCommand		= handleUserCommand;

function initAndGetUser(userName, cb) {
    async.waterfall(
        [
            function init(callback) {
                initConfigAndDatabases(callback);
            },
            function getUserObject(callback) {
                const User = require('../../core/user.js');
                User.getUserIdAndName(userName, (err, userId) => {
                    if(err) {
                        return callback(err);
                    }
                    return User.getUser(userId, callback);
                });
            }
        ],
        (err, user) => {
            return cb(err, user);
        }
    );
}

function setAccountStatus(user, status) {
    if(argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    const AccountStatus = require('../../core/user.js').AccountStatus;

    status = {
        activate    : AccountStatus.active,
        deactivate  : AccountStatus.inactive,
        disable     : AccountStatus.disabled,
        lock        : AccountStatus.locked,
    }[status];

    const statusDesc = _.invert(AccountStatus)[status];

    async.series(
        [
            (callback) => {
                return user.persistProperty(UserProps.AccountStatus, status, callback);
            },
            (callback) => {
                if(AccountStatus.active !== status) {
                    return callback(null);
                }

                return user.unlockAccount(callback);
            }
        ],
        err => {
            if(err) {
                process.exitCode = ExitCodes.ERROR;
                console.error(err.message);
            } else {
                console.info(`User status set to ${statusDesc}`);
            }
        }
    );
}

function setUserPassword(user) {
    if(argv._.length < 4) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    async.waterfall(
        [
            function validate(callback) {
                //	:TODO: prompt if no password provided (more secure, no history, etc.)
                const password = argv._[argv._.length - 1];
                if(0 === password.length) {
                    return callback(Errors.Invalid('Invalid password'));
                }
                return callback(null, password);
            },
            function set(password, callback) {
                user.setNewAuthCredentials(password, err => {
                    if(err) {
                        process.exitCode = ExitCodes.BAD_ARGS;
                    }
                    return callback(err);
                });
            }
        ],
        err => {
            if(err) {
                console.error(err.message);
            } else {
                console.info('New password set');
            }
        }
    );
}

function removeUserRecordsFromDbAndTable(dbName, tableName, userId, col, cb) {
    const db = require('../../core/database.js').dbs[dbName];
    db.run(
        `DELETE FROM ${tableName}
        WHERE ${col} = ?;`,
        [ userId ],
        err => {
            return cb(err);
        }
    );
}

function removeUser(user) {
    async.series(
        [
            (callback) => {
                if(user.isRoot()) {
                    return callback(Errors.Invalid('Cannot delete root/SysOp user!'));
                }

                return callback(null);
            },
            (callback) => {
                if(false === argv.prompt) {
                    return callback(null);
                }

                console.info('About to permanently delete the following user:');
                console.info(`Username : ${user.username}`);
                console.info(`Real name: ${user.properties[UserProps.RealName] || 'N/A'}`);
                console.info(`User ID  : ${user.userId}`);
                console.info('WARNING: This cannot be undone!');
                getAnswers([
                    {
                        name    : 'proceed',
                        message : `Proceed in deleting ${user.username}?`,
                        type    : 'confirm',
                    }
                ],
                answers => {
                    if(answers.proceed) {
                        return callback(null);
                    }
                    return callback(Errors.General('User canceled'));
                });
            },
            (callback) => {
                //  op has confirmed they are wanting ready to proceed (or passed --no-prompt)
                const DeleteFrom = {
                    message : [ 'user_message_area_last_read' ],
                    system  : [ 'user_event_log', ],
                    user    : [ 'user_group_member', 'user' ],
                };

                async.eachSeries(Object.keys(DeleteFrom), (dbName, nextDbName) => {
                    const tables = DeleteFrom[dbName];
                    async.eachSeries(tables, (tableName, nextTableName) => {
                        const col = ('user' === dbName && 'user' === tableName) ? 'id' : 'user_id';
                        removeUserRecordsFromDbAndTable(dbName, tableName, user.userId, col, err => {
                            return nextTableName(err);
                        });
                    },
                    err => {
                        return nextDbName(err);
                    });
                },
                err => {
                    return callback(err);
                });
            },
            (callback) => {
                //
                //  Clean up *private* messages *to* this user
                //
                const Message   = require('../../core/message.js');
                const MsgDb     = require('../../core/database.js').dbs.message;

                const filter = {
                    resultType          : 'id',
                    privateTagUserId    : user.userId,
                };
                Message.findMessages(filter, (err, ids) => {
                    if(err) {
                        return callback(err);
                    }

                    async.eachSeries(ids, (messageId, nextMessageId) => {
                        MsgDb.run(
                            `DELETE FROM message
                            WHERE message_id = ?;`,
                            [ messageId ],
                            err => {
                                return nextMessageId(err);
                            }
                        );
                    },
                    err => {
                        return callback(err);
                    });
                });
            }
        ],
        err => {
            if(err) {
                return console.error(err.reason ? err.reason : err.message);
            }

            console.info('User has been deleted.');
        }
    );
}

function modUserGroups(user) {
    if(argv._.length < 3) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    let groupName = argv._[argv._.length - 1].toString().replace(/["']/g, '');	//	remove any quotes - necessary to allow "-foo"
    let action = groupName[0];	//	+ or -

    if('-' === action || '+' === action) {
        groupName = groupName.substr(1);
    }

    action = action || '+';

    if(0 === groupName.length) {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    //
    //	Groups are currently arbritary, so do a slight validation
    //
    if(!/[A-Za-z0-9]+/.test(groupName)) {
        process.exitCode = ExitCodes.BAD_ARGS;
        return console.error('Bad group name');
    }

    function done(err) {
        if(err) {
            process.exitCode = ExitCodes.BAD_ARGS;
            console.error(err.message);
        } else {
            console.info('User groups modified');
        }
    }

    const UserGroup = require('../../core/user_group.js');
    if('-' === action) {
        UserGroup.removeUserFromGroup(user.userId, groupName, done);
    } else {
        UserGroup.addUserToGroup(user.userId, groupName, done);
    }
}

function showUserInfo(user) {

    const User = require('../../core/user.js');

    const statusDesc = () => {
        const status = user.properties[UserProps.AccountStatus];
        return _.invert(User.AccountStatus)[status] || 'unknown';
    };

    const created = () => {
        const ac = user.properties[UserProps.AccountCreated];
        return ac ? moment(ac).format() : 'N/A';
    };

    const lastLogin = () => {
        const ll = user.properties[UserProps.LastLoginTs];
        return ll ? moment(ll).format() : 'N/A';
    };

    const propOrNA = p => {
        return user.properties[p] || 'N/A';
    };

    console.info(`User information:
Username     : ${user.username}${user.isRoot() ? ' (root/SysOp)' : ''}
Real name    : ${propOrNA(UserProps.RealName)}
ID           : ${user.userId}
Status       : ${statusDesc()}
Groups       : ${user.groups.join(', ')}
Created      : ${created()}
Last login   : ${lastLogin()}
Login count  : ${propOrNA(UserProps.LoginCount)}
Email        : ${propOrNA(UserProps.EmailAddress)}
Location     : ${propOrNA(UserProps.Location)}
Affiliations : ${propOrNA(UserProps.Affiliations)}
`);
}

function handleUserCommand() {
    function errUsage()  {
        return printUsageAndSetExitCode(getHelpFor('User'), ExitCodes.ERROR);
    }

    if(true === argv.help) {
        return errUsage();
    }

    const action		= argv._[1];
    const usernameIdx	= [ 'pw', 'pass', 'passwd', 'password', 'group' ].includes(action) ? argv._.length - 2 : argv._.length - 1;
    const userName		= argv._[usernameIdx];

    if(!userName) {
        return errUsage();
    }

    initAndGetUser(userName, (err, user) => {
        if(err) {
            process.exitCode = ExitCodes.ERROR;
            return console.error(err.message);
        }

        return ({
            pw          : setUserPassword,
            passwd		: setUserPassword,
            password	: setUserPassword,

            rm			: removeUser,
            remove		: removeUser,
            del			: removeUser,
            delete		: removeUser,

            activate	: setAccountStatus,
            deactivate	: setAccountStatus,
            disable		: setAccountStatus,
            lock        : setAccountStatus,

            group		: modUserGroups,

            info        : showUserInfo,
        }[action] || errUsage)(user, action);
    });
}