/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/types.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <stddef.h>
#include <unistd.h>
#include <time.h>
#include <sys/time.h>
#include <errno.h>
#include <err.h>
#include <inttypes.h>
#include <limits.h>

/*
 * Sadly endian.h was added in a "recent" platform version for SmartOS/illumos
 * and we can't easily detect it without something like autotools. We need to
 * build on platforms from before this work, so the cowardly way out is just
 * to macro it up like we do here.
 */
#if defined(__sun)
#include <netinet/in.h>
#define	be64toh(v)	(ntohll(v))
#define	be32toh(v)	(ntohl(v))
#else
/* Everyone else has it :( */
#include <endian.h>
#endif

/* Our exit status codes. */
enum zklog_error_codes {
	ZKLOG_EXIT_USAGE = 1,
	ZKLOG_EXIT_ERROR = 2,
	ZKLOG_EXIT_BAD_FORMAT = 3
};


/* These all come from the ZooKeeper source (including the values). */

const uint32_t ZKLOG_MAGIC = 0x5A4B4C47;
const uint8_t ZKTXN_TERMINATOR = 0x42;

enum zklog_versions {
	ZKLOG_VERSION_2 = 2
};

enum zktxn_type {
	ZK_NOTIFICATION = 0,
	ZK_CREATE = 1,
	ZK_DELETE = 2,
	ZK_EXISTS = 3,
	ZK_GETDATA = 4,
	ZK_SETDATA = 5,
	ZK_GETACL = 6,
	ZK_SETACL = 7,
	ZK_GETCHILDREN = 8,
	ZK_SYNC = 9,
	ZK_CHECK = 13,
	ZK_MULTI = 14,
	ZK_CREATESESSION = -10,
	ZK_CLOSESESSION = -11,
	ZK_ERROR = -1
	/*
	 * Worth noting that this list is not complete: there are other types
	 * of txns that can be in the logs which we will just ignore.
	 */
};

enum zkerr {
	ERR_SYSTEM_ERROR = -1,
	ERR_RUNTIME_INCONSIST = -2,
	ERR_DATA_INCONSIST = -3,
	ERR_CONNECTION_LOSS = -4,
	ERR_UNIMPL = -6,
	ERR_TIMEOUT = -7,
	ERR_BAD_ARGS = -8,
	ERR_NO_NODE = -101,
	ERR_NODE_EXISTS = -110,
	ERR_SESSION_EXPIRED = -112,
	ERR_NOT_EMPTY = -111,
	/* Once again, this is incomplete. */
};

/*
 * The ID number of the server that a session was created on is encoded in the
 * top 8 bits of the session ID.
 */
inline static uint8_t
sid_to_srvid(uint64_t sid)
{
	return ((sid >> 56) & 0xFF);
}

const char *
zktxn_type_to_name(enum zktxn_type type)
{
	switch (type) {
	case ZK_NOTIFICATION:
		return ("NOTIFICATION");
	case ZK_CREATE:
		return ("CREATE");
	case ZK_DELETE:
		return ("DELETE");
	case ZK_CHECK:
		return ("CHECK");
	case ZK_EXISTS:
		return ("EXISTS");
	case ZK_GETDATA:
		return ("GETDATA");
	case ZK_SETDATA:
		return ("SETDATA");
	case ZK_GETACL:
		return ("GETACL");
	case ZK_SETACL:
		return ("SETACL");
	case ZK_GETCHILDREN:
		return ("GETCHILDREN");
	case ZK_SYNC:
		return ("SYNC");
	case ZK_CREATESESSION:
		return ("CREATESESSION");
	case ZK_CLOSESESSION:
		return ("CLOSESESSION");
	case ZK_MULTI:
		return ("MULTI");
	case ZK_ERROR:
		return ("ERROR");
	default:
		return ("???");
	}
}

const char *
zkerr_to_name(enum zkerr err)
{
	switch (err) {
	case ERR_SYSTEM_ERROR:
		return ("SYSTEM_ERROR");
	case ERR_RUNTIME_INCONSIST:
		return ("RUNTIME_INCONSIST");
	case ERR_DATA_INCONSIST:
		return ("DATA_INCONSIST");
	case ERR_CONNECTION_LOSS:
		return ("CONNECTION_LOSS");
	case ERR_UNIMPL:
		return ("UNIMPL");
	case ERR_TIMEOUT:
		return ("TIMEOUT");
	case ERR_BAD_ARGS:
		return ("BAD_ARGS");
	case ERR_NO_NODE:
		return ("NO_NODE");
	case ERR_NODE_EXISTS:
		return ("NODE_EXISTS");
	case ERR_SESSION_EXPIRED:
		return ("SESSION_EXPIRED");
	case ERR_NOT_EMPTY:
		return ("NOT_EMPTY");
	default:
		return ("???");
	}
}

struct zktxn_err {
	uint32_t ze_err;
} __attribute__((packed));

struct zktxn_createsess {
	uint32_t zcs_timeout;
} __attribute__((packed));

struct zktxn_multitxn {
	uint32_t zmt_type;
	uint32_t zmt_len;
	union {
		struct zktxn_err zti_err;
		struct zktxn_createsess zti_createsess;
	} zmt_inner;
} __attribute__((packed));

struct zktxn_multi {
	uint32_t zm_ntxns;
	struct zktxn_multitxn zm_txns[];
} __attribute__((packed));

struct zk_string {
	uint32_t zs_len;
	char zs_str[];
} __attribute__((packed));

struct zktxn {
	uint64_t zt_checksum;
	uint32_t zt_len;
	uint64_t zt_sessionid;
	uint32_t zt_cxid;
	uint64_t zt_zxid;
	uint64_t zt_time;
	uint32_t zt_type;
	union {
		struct zktxn_err zti_err;
		struct zktxn_createsess zti_createsess;
		struct zktxn_multi zti_multi;
	} zt_inner;
} __attribute__((packed));
/*
 * Minimum length is the size of all the fields after zt_len but before
 * zt_inner. This is also the size you have to subtract from zt_len to get
 * the *actual* size of zt_inner for a specific zktxn.
 */
#define	ZKTXN_MIN_LEN	\
    (offsetof(struct zktxn, zt_inner) - offsetof(struct zktxn, zt_len) - \
    sizeof (uint32_t))

struct zklog {
	uint32_t zl_magic;
	uint32_t zl_version;
	uint64_t zl_dbid;
	struct zktxn zl_txns[];
} __attribute__((packed));

/* End of things from the ZooKeeper source. */

struct session_state {
	struct session_state *ss_next;
	struct session_state *ss_prev;
	uint64_t ss_sid;
	uint64_t ss_start;
};

inline static unsigned int
sid_to_hash_bucket(uint64_t sid)
{
	return (sid & 0xFF);
}
#define	SID_HASH_BUCKETS	256
struct session_state *sessions[SID_HASH_BUCKETS];

static time_t zklog_mintime = 0;
static uint64_t zklog_sid = 0;
static uint8_t zklog_srvid = 0;
static int zklog_dumpdata = 0;

/*
 * Increments an offset by a given amount, checking for overflow.
 * The offset must be a size_t for this to work (and the amt any type <=
 * a size_t).
 */
#define	OFFSET_ADD(offs, amt)	do { \
	size_t _new_offset = (offs) + (amt); \
	if (_new_offset < (offs) || _new_offset < (amt)) { \
		errx(ZKLOG_EXIT_BAD_FORMAT, "bad length caused overflow"); \
	} \
	(offs) = _new_offset; \
    } while (0);

static void
print_inner(struct zktxn *txn, const char *timebuf, enum zktxn_type type,
    void *inner, size_t len)
{
	if (type == ZK_ERROR) {
		if (len < sizeof (struct zktxn_err)) {
			errx(ZKLOG_EXIT_BAD_FORMAT,
			    "txn too short for ZK_ERROR: %lu", len);
		}
		struct zktxn_err *err = (struct zktxn_err *)inner;
		err->ze_err = be32toh(err->ze_err);
		(void) printf(",\"error\":\"%s\",\"errid\":%d",
		    zkerr_to_name((int32_t)err->ze_err),
		    (int32_t)err->ze_err);

	} else if (type == ZK_CREATESESSION) {
		if (len < sizeof (struct zktxn_createsess)) {
			errx(ZKLOG_EXIT_BAD_FORMAT,
			    "txn too short for ZK_CREATESESSION: %lu", len);
		}
		struct zktxn_createsess *cs = (struct zktxn_createsess *)inner;
		cs->zcs_timeout = be32toh(cs->zcs_timeout);
		(void) printf(",\"timeout\":\"%d\"", (int32_t)cs->zcs_timeout);

	} else if (type == ZK_CREATE || type == ZK_SETDATA ||
	    type == ZK_DELETE || type == ZK_CHECK || type == ZK_SETACL) {
		size_t offset = 0;
		struct zk_string *name = (struct zk_string *)(inner + offset);

		OFFSET_ADD(offset, sizeof (struct zk_string));
		if (offset > len) {
			errx(ZKLOG_EXIT_BAD_FORMAT,
			    "txn too short for %s (decoding node name): %lu",
			    zktxn_type_to_name(type), len);
		}

		name->zs_len = be32toh(name->zs_len);

		OFFSET_ADD(offset, name->zs_len);
		if (offset > len) {
			errx(ZKLOG_EXIT_BAD_FORMAT,
			    "txn too short for %s: %lu",
			    zktxn_type_to_name(type), len);
		}

		char *namestr = strndup(name->zs_str, name->zs_len);
		if (namestr == NULL)
			err(ZKLOG_EXIT_ERROR, "failed to allocate memory");
		(void) printf(",\"path\":\"%s\"", namestr);
		free(namestr);

		/* Only CREATE/SETDATA have data fields. */
		if (type != ZK_CREATE && type != ZK_SETDATA)
			return;
		/* Skip unless they gave us -d. */
		if (!zklog_dumpdata)
			return;

		struct zk_string *data = (struct zk_string *)(inner + offset);

		OFFSET_ADD(offset, sizeof (struct zk_string));
		if (offset > len) {
			errx(ZKLOG_EXIT_BAD_FORMAT,
			    "txn too short for %s (decoding data field): %lu",
			    zktxn_type_to_name(type), len);
		}

		data->zs_len = be32toh(data->zs_len);

		/*
		 * CREATE can have data len set to -1 (signed) to indicate
		 * that no data was included with the CREATE command. ZK plays
		 * a bit fast and loose with signedness unfortunately.
		 */
		if ((int32_t)data->zs_len < 0)
			return;

		OFFSET_ADD(offset, data->zs_len);
		if (offset > len) {
			errx(ZKLOG_EXIT_BAD_FORMAT,
			    "txn too short for %s (in data, %u bytes): %lu",
			    zktxn_type_to_name(type), data->zs_len, len);
		}
		(void) printf(",\"data\":\"");
		for (size_t i = 0; i < data->zs_len; ++i)
			(void) printf("%02x", data->zs_str[i]);
		(void) printf("\"");

	} else if (type == ZK_MULTI) {
		size_t offset = 0;
		if (len < sizeof (struct zktxn_multi)) {
			errx(ZKLOG_EXIT_BAD_FORMAT,
			    "txn too short for ZK_MULTI: %lu", len);
		}
		struct zktxn_multi *m = &txn->zt_inner.zti_multi;
		m->zm_ntxns = be32toh(m->zm_ntxns);
		(void) printf(",\"count\":%d}\n", m->zm_ntxns);

		OFFSET_ADD(offset, sizeof (struct zktxn_multi));
		/* We already checked len above */

		for (size_t i = 0; i < m->zm_ntxns; ++i) {
			struct zktxn_multitxn *mt =
			    (struct zktxn_multitxn *)(inner + offset);

			OFFSET_ADD(offset, offsetof(struct zktxn_multitxn,
			    zmt_len));
			OFFSET_ADD(offset, sizeof (mt->zmt_len));
			if (offset > len) {
				errx(ZKLOG_EXIT_BAD_FORMAT,
				    "txn too short for ZK_MULTI (at child txn "
				    "%zu): %lu", i, len);
			}

			mt->zmt_type = be32toh(mt->zmt_type);
			mt->zmt_len = be32toh(mt->zmt_len);

			OFFSET_ADD(offset, mt->zmt_len);
			if (offset > len) {
				errx(ZKLOG_EXIT_BAD_FORMAT,
				    "txn too short for ZK_MULTI (after inner "
				    "length of child txn %zu): %lu", i, len);
			}

			(void) printf("{\"time\":\"%s\",\"type\":\"%s\","
			    "\"typeid\":%d,"
			    "\"sessionid\":\"%" PRIx64 "\","
			    "\"cxid\":\"%x\",\"zxid\":\"%" PRIx64 "\"",
			    timebuf,
			    zktxn_type_to_name((enum zktxn_type)mt->zmt_type),
			    (int32_t)mt->zmt_type, txn->zt_sessionid,
			    txn->zt_cxid, txn->zt_zxid);

			print_inner(txn, timebuf, (enum zktxn_type)mt->zmt_type,
			    &mt->zmt_inner, mt->zmt_len);

			if (i + 1 < m->zm_ntxns)
				(void) printf("}\n");
		}
	}
	/*
	 * For other types we don't print any additional information. Not
	 * handling them here is fine.
	 */
}

static void
do_file(const char *fname)
{
	int fd;
	uint8_t *data;
	struct zklog *log;
	struct zktxn *txn;
	struct stat stat;
	size_t len;
	size_t offset;
	char timebuf[64];
	time_t t, tms;
	struct tm *tm;
	struct session_state *sess, **head;
	uint64_t duration;

	fd = open(fname, O_RDONLY);
	if (fd < 0)
		err(ZKLOG_EXIT_ERROR, "error opening file '%s'", fname);

	if (fstat(fd, &stat))
		err(ZKLOG_EXIT_ERROR, "error getting size of file '%s'", fname);

	len = stat.st_size;
	if (len < sizeof (struct zklog)) {
		errx(ZKLOG_EXIT_BAD_FORMAT, "file %s is too small to be "
		    "a txnlog", fname);
	}

	data = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_PRIVATE, fd, 0);
	if (data == MAP_FAILED) {
		err(ZKLOG_EXIT_ERROR, "error mapping file '%s' into memory",
		    fname);
	}

	log = (struct zklog *)data;

	log->zl_magic = be32toh(log->zl_magic);
	if (log->zl_magic != ZKLOG_MAGIC)
		errx(ZKLOG_EXIT_BAD_FORMAT, "bad magic number in '%s'", fname);

	log->zl_version = be32toh(log->zl_version);
	if (log->zl_version != ZKLOG_VERSION_2) {
		errx(ZKLOG_EXIT_BAD_FORMAT, "txnlog '%s' has unknown log "
		    "version: %u", fname, log->zl_version);
	}

	offset = (uintptr_t)log->zl_txns - (uintptr_t)data;
	while (offset < len) {
		txn = (struct zktxn *)(data + offset);

		OFFSET_ADD(offset, offsetof(struct zktxn, zt_len));
		OFFSET_ADD(offset, sizeof (txn->zt_len));
		if (offset > len) {
			errx(ZKLOG_EXIT_BAD_FORMAT, "bad txn entry in '%s' "
			    "around +0x%lx", fname, offset);
		}

		txn->zt_len = be32toh(txn->zt_len);

		if (txn->zt_len == 0)
			break;
		if (txn->zt_len < ZKTXN_MIN_LEN) {
			errx(ZKLOG_EXIT_BAD_FORMAT, "txn entry too short in "
			    "'%s' around +0x%lx", fname, offset);
		}

		OFFSET_ADD(offset, txn->zt_len);
		if (offset >= len || data[offset] != ZKTXN_TERMINATOR) {
			errx(ZKLOG_EXIT_BAD_FORMAT, "bad txn entry in '%s' "
			    "around +0x%lx", fname, offset);
		}

		OFFSET_ADD(offset, 1);
		/* Checked by the >= above */

		txn->zt_sessionid = be64toh(txn->zt_sessionid);
		txn->zt_cxid = be32toh(txn->zt_cxid);
		txn->zt_zxid = be64toh(txn->zt_zxid);
		txn->zt_time = be64toh(txn->zt_time);
		txn->zt_type = be32toh(txn->zt_type);

		tms = txn->zt_time % 1000;
		t = txn->zt_time / 1000;

		duration = 0;

		head = &sessions[sid_to_hash_bucket(txn->zt_sessionid)];
		for (sess = *head; sess != NULL; sess = sess->ss_next) {
			if (sess->ss_sid == txn->zt_sessionid)
				break;
		}

		if (sess == NULL &&
		    (enum zktxn_type)txn->zt_type == ZK_CREATESESSION) {
			sess = calloc(1, sizeof (struct session_state));
			if (sess == NULL) {
				err(ZKLOG_EXIT_ERROR,
				    "failed to allocate memory");
			}
			sess->ss_next = *head;
			sess->ss_sid = txn->zt_sessionid;
			sess->ss_start = txn->zt_time;
			if (*head != NULL)
				(*head)->ss_prev = sess;
			*head = sess;
		}

		if (sess != NULL &&
		    (enum zktxn_type)txn->zt_type == ZK_CLOSESESSION) {
			duration = txn->zt_time - sess->ss_start;
			if (sess->ss_next != NULL)
				sess->ss_next->ss_prev = sess->ss_prev;
			if (sess->ss_prev != NULL)
				sess->ss_prev->ss_next = sess->ss_next;
			if (*head == sess)
				*head = sess->ss_next;
			free(sess);
		}

		if (t < zklog_mintime)
			continue;
		if (zklog_sid != 0 && zklog_sid != txn->zt_sessionid)
			continue;
		if (zklog_srvid != 0 &&
		    sid_to_srvid(txn->zt_sessionid) != zklog_srvid) {
			continue;
		}

		tm = gmtime(&t);
		if (tm == NULL)
			err(ZKLOG_EXIT_ERROR, "failed to convert time format");
		(void) snprintf(timebuf, sizeof (timebuf),
		    "%04d-%02d-%02dT%02d:%02d:%02d.%03zuZ",
		    tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday,
		    tm->tm_hour, tm->tm_min, tm->tm_sec, (size_t)tms);

		(void) printf("{\"time\":\"%s\",\"type\":\"%s\",\"typeid\":%d,"
		    "\"sessionid\":\"%" PRIx64 "\","
		    "\"cxid\":\"%x\",\"zxid\":\"%" PRIx64 "\"",
		    timebuf, zktxn_type_to_name((enum zktxn_type)txn->zt_type),
		    (int32_t)txn->zt_type, txn->zt_sessionid, txn->zt_cxid,
		    txn->zt_zxid);

		if ((enum zktxn_type)txn->zt_type == ZK_CLOSESESSION &&
		    duration != 0) {
			(void) printf(",\"duration\":%" PRIu64, duration);
		}

		void *inner = &txn->zt_inner;
		size_t innerlen = txn->zt_len - ZKTXN_MIN_LEN;

		print_inner(txn, timebuf, (enum zktxn_type)txn->zt_type, inner,
		    innerlen);

		(void) printf("}\n");
	}

	if (munmap((void *)data, len))
		err(ZKLOG_EXIT_ERROR, "error unmapping '%s'", fname);

	if (close(fd))
		err(ZKLOG_EXIT_ERROR, "error closing file '%s'", fname);
}

static void
usage(void)
{
	(void) fprintf(stderr,
	    "usage: zklog [-Sd] [-t secs] [-s sid] [-z srvid] <txnlog> "
	    "[txnlog2 ...]\n");
	(void) fprintf(stderr,
	    "converts ZK replicated txn log files into JSON\n");
	(void) fprintf(stderr, "options:\n"
	    "    -S        dumps records about all still-active sessions at\n"
	    "              the end of the log (with type '_SESSION')\n"
	    "    -d        include node data in the output (e.g. actual\n"
	    "              contents of nodes)\n"
	    "\n"
	    "filter options:\n"
	    "    -t secs   output only records that were timestamped within\n"
	    "              the last <secs> seconds\n"
	    "    -s sid    output only records matching the given zk session\n"
	    "              id (in hex)\n"
	    "    -z srvid  output only records recorded by the given server\n"
	    "              id\n"
	    "\n"
	    "example:\n"
	    "  find .../zookeeper/version-2 -name 'log.*' | "
	    "sort -n | tail -n 10 | xargs ./zklog -d\n");
	exit(ZKLOG_EXIT_USAGE);
}

int
main(int argc, char *argv[])
{
	int opt;
	struct timeval now;
	char *p;
	int dumpsess = 0;
	unsigned long int parsed;

	if (gettimeofday(&now, NULL))
		err(ZKLOG_EXIT_ERROR, "failed to get system time");

	while ((opt = getopt(argc, argv, "Sdt:s:z:")) != -1) {
		switch (opt) {
		case 'S':
			dumpsess++;
			break;
		case 't':
			errno = 0;
			parsed = strtoul(optarg, &p, 10);
			if (errno != 0 || *p != '\0') {
				errx(ZKLOG_EXIT_USAGE,
				    "invalid argument for -t: '%s'", optarg);
			}
			zklog_mintime = now.tv_sec - parsed;
			break;
		case 's':
			errno = 0;
			zklog_sid = strtoull(optarg, &p, 16);
			if (errno != 0 || *p != '\0') {
				errx(ZKLOG_EXIT_USAGE,
				    "invalid session id '%s'", optarg);
			}
			break;
		case 'd':
			zklog_dumpdata = 1;
			break;
		case 'z':
			errno = 0;
			parsed = strtoul(optarg, &p, 0);
			if (errno != 0 || *p != '\0' || parsed > 0xFF) {
				errx(ZKLOG_EXIT_USAGE,
				    "invalid server id '%s'", optarg);
			}
			zklog_srvid = (uint8_t)parsed;
			break;
		default:
			usage();
		}
	}

	if (optind >= argc) {
		(void) fprintf(stderr, "error: no zklog files specified\n");
		usage();
	}

	while (optind < argc)
		do_file(argv[optind++]);

	if (dumpsess) {
		struct session_state *sess;
		size_t sidlow;
		uint64_t nowms, duration;

		/*
		 * It might have taken quite a while to get through all the
		 * txnlogs we were given. So, to make the "duration" values for
		 * the _SESSION records more accurate we update "now" here.
		 */
		if (gettimeofday(&now, NULL))
			err(ZKLOG_EXIT_ERROR, "failed to get system time");

		nowms = now.tv_sec * 1000 + (now.tv_usec / 1000);

		for (sidlow = 0; sidlow < SID_HASH_BUCKETS; ++sidlow) {
			sess = sessions[sidlow];
			for (; sess != NULL; sess = sess->ss_next) {
				if (zklog_sid != 0 && zklog_sid != sess->ss_sid)
					continue;
				if (zklog_srvid != 0 &&
				    sid_to_srvid(sess->ss_sid) != zklog_srvid) {
					continue;
				}
				duration = nowms - sess->ss_start;
				if (sess->ss_start > nowms)
					duration = 0;
				(void) printf("{\"type\":\"_SESSION\","
				    "\"sid\":\"%" PRIx64 "\""
				    ",\"duration\":%" PRIu64 "}\n",
				    sess->ss_sid, duration);
			}
		}
	}

	return (0);
}
