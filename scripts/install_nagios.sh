#!/bin/bash
# +------------------------------------------------------------------+
# |             ____ _               _        __  __ _  __           |
# |            / ___| |__   ___  ___| | __   |  \/  | |/ /           |
# |           | |   | '_ \ / _ \/ __| |/ /   | |\/| | ' /            |
# |           | |___| | | |  __/ (__|   <    | |  | | . \            |
# |            \____|_| |_|\___|\___|_|\_\___|_|  |_|_|\_\           |
# |                                                                  |
# | Copyright Mathias Kettner 2009             mk@mathias-kettner.de |
# +------------------------------------------------------------------+
# 
# This file is part of Check_MK.
# The official homepage is at http://mathias-kettner.de/check_mk.
# 
# check_mk is free software;  you can redistribute it and/or modify it
# under the  terms of the  GNU General Public License  as published by
# the Free Software Foundation in version 2.  check_mk is  distributed
# in the hope that it will be useful, but WITHOUT ANY WARRANTY;  with-
# out even the implied warranty of  MERCHANTABILITY  or  FITNESS FOR A
# PARTICULAR PURPOSE. See the  GNU General Public License for more de-
# ails.  You should have  received  a copy of the  GNU  General Public
# License along with GNU Make; see the file  COPYING.  If  not,  write
# to the Free Software Foundation, Inc., 51 Franklin St,  Fifth Floor,
# Boston, MA 02110-1301 USA.



# Make sure, /usr/local/bin is in the PATH, since we install
# programs there...
PATH=$PATH:/usr/local/bin

LOGFILE=install_nagios.sh.log
exec > >(tee $LOGFILE) 2>&1

set -e

NAGIOS_VERSION=3.2.0
PLUGINS_VERSION=1.4.14
CHECK_MK_VERSION=1.1.2
PNP_VERSION=0.6.2
NAGVIS_VERSION=1.4.5
RRDTOOL_VERSION=1.4.2

SOURCEFORGE_MIRROR=dfn
NAGIOS_URL="http://downloads.sourceforge.net/project/nagios/nagios-3.x/nagios-$NAGIOS_VERSION/nagios-$NAGIOS_VERSION.tar.gz?use_mirror=$SOURCEFORGE_MIRROR"
PLUGINS_URL="http://downloads.sourceforge.net/project/nagiosplug/nagiosplug/$PLUGINS_VERSION/nagios-plugins-$PLUGINS_VERSION.tar.gz?use_mirror=$SOURCEFORGE_MIRROR"
CHECK_MK_URL="http://mathias-kettner.de/download/check_mk-$CHECK_MK_VERSION.tar.gz"
NAGVIS_URL="http://downloads.sourceforge.net/project/nagvis/NagVis%201.4%20%28stable%29/NagVis-$NAGVIS_VERSION/nagvis-$NAGVIS_VERSION.tar.gz?use_mirror=$SOURCEFORGE_MIRROR"
if [ "${PNP_VERSION:2:1}" = 6 ]
then
   PNP_URL="http://downloads.sourceforge.net/project/pnp4nagios/PNP-${PNP_VERSION:0:3}/pnp4nagios-$PNP_VERSION.tar.gz?use_mirror=$SOURCEFORGE_MIRROR"
   PNP_DATAOPTION=--datarootdir=/usr/local/share/pnp4nagios
   PNP_NAME=pnp4nagios
else
   PNP_URL="http://downloads.sourceforge.net/project/pnp4nagios/PNP/pnp-${PNP_VERSION}/pnp-${PNP_VERSION}.tar.gz?use_mirror=$SOURCEFORGE_MIRROR"
   PNP_DATAOPTION=--datadir=/usr/local/share/nagios/htdocs/pnp
   PNP_NAME=pnp
fi

RRDTOOL_URL="http://oss.oetiker.ch/rrdtool/pub/rrdtool-$RRDTOOL_VERSION.tar.gz"


if [ "$(cat /etc/redhat-release 2>/dev/null)" = "Red Hat Enterprise Linux Server release 5.3 (Tikanga)" ]
then
    DISTRO=REDHAT
    DISTRONAME="RedHat 5.3"
    DISTROVERS=5.3
elif [ "$(cat /etc/redhat-release 2>/dev/null)" = "CentOS release 5.3 (Final)" ]
then
    DISTRO=REDHAT
    DISTRONAME="CentOS 5.3"
    DISTROVERS=5.3
elif grep -qi "USE Linux Enterprise Server 11" /etc/SuSE-release 2>/dev/null
then
    DISTRO=SUSE
    DISTRONAME="SLES 11"
    DISTROVERS=11
else
    debvers=$(cat /etc/debian_version)
    debvers=${debvers:0:3}
    if [ "$debvers" = 5.0 ]
    then
        DISTRO=DEBIAN
        DISTRONAME="Debian 5.0 (Lenny)"
        DISTROVERS=5.0
    fi
fi

case "$DISTRO" in 
    REDHAT)
    	HTTPD=httpd
    	WWWUSER=apache
	WWWGROUP=apache
        activate_initd () { chkconfig $1 on ; }
        add_user_to_group () { gpasswd -a $1 $2 ; }
    ;;
    SUSE)
	HTTPD=apache2
	WWWUSER=wwwrun
	WWWGROUP=www
        activate_initd () { chkconfig $1 on ; }
        add_user_to_group () { groupmod -A $1 $2 ; }
    ;;
    DEBIAN)
	HTTPD=apache2
	WWWUSER=www-data
	WWWGROUP=www-data
        activate_initd () { update-rc.d $1 defaults; }
        add_user_to_group () { gpasswd -a $1 $2 ; }
    ;;
    *)
	echo "This script does not work on your Linux distribution. Sorry."
	echo "Supported are: Debian 5.0, SLES 11 and RedHat/CentOS 5.3"
        exit 1
esac	

cat <<EOF

This script is intended for setting up Nagios, PNP4Nagios, NagVis and
Check_MK on a freshly installed Linux system. It will:

 - probably delete your existing Nagios configuration (if any)
 - install missing packages via apt/yum/zypper
 - download software from various internet sources
 - compile Nagios, PNP4Nagios and MK Livestatus
 - install everything into FHS-compliant paths below /etc,
   /var and /usr/local
 - setup Nagios, Apache, PNP4Nagios, NagVis and Check_MK
 - install the check_mk_agent on localhost
 - setup Nagios to monitor localhost

   You Linux distro:     $DISTRONAME
   Nagios version:       $NAGIOS_VERSION
   Plugins version:      $PLUGINS_VERSION
   Check_MK version:     $CHECK_MK_VERSION
   rrdtool version:      $RRDTOOL_VERSION
   PNP4Nagios version:   $PNP_VERSION
   Nagvis version:       $NAGVIS_VERSION

The output of this script is logged into $LOGFILE.

No user interaction is neccesary. Do you want to proceed?
EOF

echo -n 'Then please enter "yes": '
read yes
[ "$yes" = yes ] || exit 0

set -e


heading ()
{
    echo
    echo '//===========================================================================\\'
    printf "|| %-73s ||\n" "$1"
    echo '\\===========================================================================//'
    echo
}


heading "Installing missing software"

if [ "$DISTRO" = DEBIAN ]
then
  aptitude -y update
  aptitude -y install psmisc build-essential nail  \
    apache2 libapache2-mod-php5 python rrdtool php5-gd libgd-dev \
    python-rrdtool xinetd wget libgd2-xpm-dev psmisc less libapache2-mod-python \
    graphviz php5-sqlite sqlite php-gettext locales-all libxml2-dev libpango1.0-dev
    # Hint for Debian: Installing the packages locales-all is normally not neccessary
    # if you use 'dpkg-reconfigure locales' to setup and generate your locales.
    # Correct locales are needed for the localisation of Nagvis.
elif [ "$DISTRO" = SUSE ]
then
   zypper update
   zypper -n install apache2 mailx apache2-mod_python apache2-mod_php5 php5-gd gd-devel \
	xinetd wget xorg-x11-libXpm-devel psmisc less graphviz-devel graphviz-gd \
	php5-sqlite php5-gettext python-rrdtool php5-zlib php5-sockets php5-mbstring gcc \
	cairo-devel libxml-devel libxml2-devel pango-devel gcc-c++
else
   yum update
   yum -y install httpd gcc mailx php php-gd gd-devl xinetd wget psmisc less mod_python \
     sqlite cairo-devel libxml2-devel pango-devel pango libpng-devel freetype freetype-devel libart_lgpl-devel 
fi


set +e
killall nagios
killall -9 nagios
killall npcd
set -e


# Compile rrdtool
heading "RRDTool"
[ -e rrdtool-$RRDTOOL_VERSION ] || wget $RRDTOOL_URL
rm -rf rrdtool-$RRDTOOL_VERSION
tar xzf rrdtool-$RRDTOOL_VERSION.tar.gz
pushd rrdtool-$RRDTOOL_VERSION
./configure --prefix=/usr/local
make -j 16
make install
popd


# Compile plugins
heading "Nagios plugins"
[ -e nagios-plugins-$PLUGINS_VERSION.tar.gz ] || wget $PLUGINS_URL
rm -rf nagios-plugins-$PLUGINS_VERSION
tar xzf nagios-plugins-$PLUGINS_VERSION.tar.gz
pushd nagios-plugins-$PLUGINS_VERSION
./configure \
  --libexecdir=/usr/local/lib/nagios/plugins
make -j 16
make install
popd

# Compile Nagios
heading "Nagios"
# Mounting tmpfs to /var/spool/nagios
umount /var/spool/nagios 2>/dev/null || true
mkdir -p /var/spool/nagios
sed -i '\/var\/lib\/nagios\/spool tmpfs/d' /etc/fstab
echo 'tmpfs /var/spool/nagios tmpfs defaults 0 0' >> /etc/fstab
mount /var/spool/nagios

[ -e nagios-$NAGIOS_VERSION.tar.gz ] || wget $NAGIOS_URL
rm -rf nagios-$NAGIOS_VERSION
tar xzf nagios-$NAGIOS_VERSION.tar.gz
pushd nagios-$NAGIOS_VERSION
groupadd -r nagios >/dev/null 2>&1 || true
id nagios >/dev/null 2>&1 || useradd -c 'Nagios Daemon' -s /bin/false -d /var/lib/nagios -r -g nagios nagios
./configure \
  --with-nagios-user=nagios \
  --with-nagios-group=nagios \
  --with-command-user=$WWWUSER \
  --with-command-group=nagios \
  --with-mail=mail \
  --with-httpd-conf=/etc/nagios \
  --with-checkresult-dir=/var/spool/nagios/checkresults \
  --with-temp-dir=/var/lib/nagios/tmp \
  --with-init-dir=/etc/init.d \
  --with-lockfile=/var/run/nagios.lock \
  --with-cgiurl=/nagios/cgi-bin \
  --with-htmurl=/nagios \
  --bindir=/usr/local/bin \
  --sbindir=/usr/local/lib/nagios/cgi-bin \
  --libexecdir=/usr/local/lib/nagios \
  --sysconfdir=/etc/nagios \
  --sharedstatedir=/var/lib/nagios \
  --localstatedir=/var/lib/nagios \
  --libdir=/usr/local/lib/nagios \
  --includedir=/usr/local/include/nagios \
  --datadir=/usr/local/share/nagios/htdocs \
  --disable-statuswrl \
  --enable-nanosleep \
  --enable-event-broker \
  --disable-embedded-perl

make -j 16 all

make \
  install \
  install-cgis \
  install-html \
  install-init \
  install-commandmode \
  install-config 

chown -R root.root \
  /usr/local/bin/nagios* \
  /usr/local/*/nagios \
  /etc/nagios

sed -i '/CONFIG ERROR/a\                        $NagiosBin -v $NagiosCfgFile'  /etc/init.d/nagios


mkdir -p /var/spool/nagios/tmp
chown -R nagios.nagios /var/lib/nagios
mkdir -p /var/log/nagios/archives
chown -R nagios.nagios /var/log/nagios
mkdir -p /var/cache/nagios
chown nagios.nagios /var/cache/nagios
mkdir -p /var/run/nagios/rw
chown nagios.nagios /var/run/nagios/rw
chmod 2755 /var/run/nagios/rw
mkdir -p  /var/lib/nagios/rrd
chown nagios.nagios /var/lib/nagios/rrd
mkdir -p /var/spool/nagios/pnp/npcd
chown -R nagios.nagios /var/spool/nagios
chown root.nagios /usr/local/lib/nagios/plugins/check_icmp
chmod 4750 /usr/local/lib/nagios/plugins/check_icmp

# Prepare configuration
popd
pushd /etc/nagios
mv nagios.cfg nagios.cfg-example
mv objects conf.d-example
: > resource.cfg
cat <<EOF > nagios.cfg
# Paths
lock_file=/var/run/nagios.lock
temp_file=/var/spool/nagios/nagios.tmp
temp_path=/var/spool/nagios/tmp
log_archive_path=/var/log/nagios/archives
check_result_path=/var/spool/nagios/checkresults
state_retention_file=/var/lib/nagios/retention.dat
debug_file=/var/log/nagios/nagios.debug
command_file=/var/run/nagios/rw/nagios.cmd
log_file=/var/log/nagios/nagios.log
cfg_dir=/etc/nagios/conf.d
object_cache_file=/var/cache/nagios/objects.cache
precached_object_file=/var/cache/nagios/objects.precache
resource_file=/etc/nagios/resource.cfg
status_file=/var/spool/nagios/status.dat

# Logging
log_rotation_method=w
use_syslog=0
log_notifications=1
log_service_retries=0
log_host_retries=1
log_event_handlers=1
log_initial_states=0
log_external_commands=0
log_passive_checks=0

status_update_interval=10
nagios_user=nagios
nagios_group=nagios
check_external_commands=1
command_check_interval=-1
external_command_buffer_slots=4096
max_service_check_spread=1
max_host_check_spread=1
check_result_reaper_frequency=1
service_check_timeout=120
host_check_timeout=30
retain_state_information=1
retention_update_interval=60
use_retained_program_state=1
use_retained_scheduling_info=1
retained_host_attribute_mask=0
retained_service_attribute_mask=0
retained_process_host_attribute_mask=0
retained_process_service_attribute_mask=0
retained_contact_host_attribute_mask=0
retained_contact_service_attribute_mask=0
check_for_updates=0
process_performance_data=1
date_format=iso8601
enable_embedded_perl=0
use_regexp_matching=0
use_true_regexp_matching=0
use_large_installation_tweaks=1
enable_environment_macros=1
debug_level=0
debug_verbosity=0
max_debug_file_size=1000000

# PNP4Nagios
service_perfdata_file=/var/spool/nagios/pnp/service-perfdata
service_perfdata_file_template=DATATYPE::SERVICEPERFDATA\tTIMET::\$TIMET\$\tHOSTNAME::\$HOSTNAME\$\tSERVICEDESC::\$SERVICEDESC\$\tSERVICEPERFDATA::\$SERVICEPERFDATA\$\tSERVICECHECKCOMMAND::\$SERVICECHECKCOMMAND\$\tHOSTSTATE::\$HOSTSTATE\$\tHOSTSTATETYPE::\$HOSTSTATETYPE\$\tSERVICESTATE::\$SERVICESTATE\$\tSERVICESTATETYPE::\$SERVICESTATETYPE\$
service_perfdata_file_mode=a
service_perfdata_file_processing_interval=10
service_perfdata_file_processing_command=process-service-perfdata-file

host_perfdata_file=/var/spool/nagios/pnp/host-perfdata
host_perfdata_file_template=DATATYPE::HOSTPERFDATA\tTIMET::\$TIMET\$\tHOSTNAME::\$HOSTNAME\$\tHOSTPERFDATA::\$HOSTPERFDATA\$\tHOSTCHECKCOMMAND::\$HOSTCHECKCOMMAND\$\tHOSTSTATE::\$HOSTSTATE\$\tHOSTSTATETYPE::\$HOSTSTATETYPE\$
host_perfdata_file_mode=a
host_perfdata_file_processing_interval=10
host_perfdata_file_processing_command=process-host-perfdata-file

# Illegal characters
EOF

grep 'illegal.*=' nagios.cfg-example >> nagios.cfg

# Modify init-script: It must create the temp directory,
# as it is in a tmpfs...
sed -i -e '/^[[:space:]]start)/a                mkdir -p /var/spool/nagios/tmp /var/spool/nagios/checkresults' \
       -e '/^[[:space:]]start)/a                chown nagios.nagios /var/spool/nagios/tmp /var/spool/nagios/checkresults' /etc/init.d/nagios

# Make CGIs display addons in right frame, not in a new window
sed -i 's/_blank/main/g' cgi.cfg

mkdir -p conf.d
cat <<EOF > conf.d/timeperiods.cfg
define timeperiod {
        timeperiod_name 24x7
        alias           24 Hours A Day, 7 Days A Week
        sunday          00:00-24:00
        monday          00:00-24:00
        tuesday         00:00-24:00
        wednesday       00:00-24:00
        thursday        00:00-24:00
        friday          00:00-24:00
        saturday        00:00-24:00
}
EOF

cat <<EOF > conf.d/localhost.cfg
define contact {
   contact_name                  hh
   alias                         Harri Hirsch
   email                         ha@hirsch.de
   host_notification_commands    dummy
   service_notification_commands dummy
}

define contactgroup {
   contactgroup_name     admins
   alias                 All Admins
   members               hh
}

define hostgroup {
  hostgroup_name         all
  alias                  All Rechner
}

define host {
  host_name              nagios
  alias                  The Nagios Server
  hostgroups             all
  contact_groups         admins
  address                127.0.0.1
  max_check_attempts     1
  notification_interval  0
  check_command          check-icmp
}

define service {
  host_name              nagios
  check_command          dummy
  service_description    PING
  max_check_attempts     1
  normal_check_interval  1
  retry_check_interval   1
  notification_interval  0
}

define command {
  command_name dummy
  command_line echo 'OK - Dummy check, always true'
}

define command {
  command_name check-icmp
  command_line /usr/local/lib/nagios/plugins/check_icmp $HOSTADDRESS$
}

EOF

cat <<EOF > conf.d/pnp4nagios.cfg
define command {
       command_name    process-service-perfdata-file
       command_line    /bin/mv /var/spool/nagios/pnp/service-perfdata /var/spool/nagios/pnp/npcd/service-perfdata.\$TIMET\$
}

define command {
       command_name    process-host-perfdata-file
       command_line    /bin/mv /var/spool/nagios/pnp/host-perfdata /var/spool/nagios/pnp/npcd/host-perfdata.\$TIMET\$
}
EOF


echo 'nagiosadmin:vWQwFr7mwjvmI' > htpasswd


mkdir -p /etc/$HTTPD/conf.d
ln -sfn /etc/nagios/$HTTPD.conf /etc/$HTTPD/conf.d/nagios.conf

rm -rf conf.d-example

popd

# =============================================================================
# PNP4Nagios
# =============================================================================

# Compile and install PNP4Nagios
heading "PNP4Nagios"
[ -e $PNP_NAME-$PNP_VERSION.tar.gz ] || wget "$PNP_URL"
tar xzf $PNP_NAME-$PNP_VERSION.tar.gz
pushd $PNP_NAME-$PNP_VERSION

./configure \
  --bindir=/usr/local/bin \
  --sbindir=/usr/local/lib/nagios/cgi-bin \
  --libexecdir=/usr/local/lib/nagios \
  --sysconfdir=/etc/nagios \
  --sharedstatedir=/var/lib/nagios \
  --localstatedir=/var/lib/nagios \
  --libdir=/usr/local/lib/nagios \
  --includedir=/usr/local/include/nagios \
  $PNP_DATAOPTION

make all
make install install-config install-webconf
install -m 644 contrib/ssi/status-header.ssi /usr/local/share/nagios/htdocs/ssi/
rm -rf /etc/nagios/check_commands
popd
pushd /etc/nagios
mv rra.cfg-sample rra.cfg
rm -f npcd.cfg*
cat <<EOF > npcd.cfg
user = nagios
group = nagios
log_type = file
log_file = /var/log/nagios/npcd.log
max_logfile_size = 10485760
log_level = 0
perfdata_spool_dir = /var/spool/nagios/pnp/npcd
perfdata_file_run_cmd = /usr/local/lib/nagios/process_perfdata.pl
perfdata_file_run_cmd_args = -b
identify_npcd = 1
npcd_max_threads = 5
sleep_time = 15
load_threshold = 0.0
pid_file = /var/run/npcd.pid
# This line must be here. Bug in ncpd. Sorry.
EOF

rm -f process_perfdata.cfg*
cat <<EOF > process_perfdata.cfg
TIMEOUT = 5
USE_RRDs = 1 
RRDPATH = /var/lib/nagios/rrd
RRDTOOL = /usr/local/bin/rrdtool
CFG_DIR = /etc/nagios
RRD_STORAGE_TYPE = SINGLE
RRD_HEARTBEAT = 8460 
RRA_CFG = /etc/nagios/rra.cfg
RRA_STEP = 60
LOG_FILE = /var/log/nagios/perfdata.log
LOG_LEVEL = 0
XML_ENC = UTF-8
XML_UPDATE_DELAY = 0
RRD_DAEMON_OPTS = 
EOF

rm -f config.php*
cat <<EOF > config.php
<?php
\$conf['use_url_rewriting'] = 1;
\$conf['rrdtool'] = "/usr/local/bin/rrdtool";
\$conf['graph_width'] = "500";
\$conf['graph_height'] = "100";
\$conf['pdf_width'] = "675";
\$conf['pdf_height'] = "100";
\$conf['graph_opt'] = ""; 
\$conf['pdf_graph_opt'] = ""; 
\$conf['rrdbase'] = "/var/lib/nagios/rrd/";
\$conf['page_dir'] = "/etc/nagios/pages/";
\$conf['refresh'] = "90";
\$conf['max_age'] = 60*60*6;   
\$conf['temp'] = "/var/tmp";
\$conf['nagios_base'] = "/nagios/cgi-bin";
\$conf['allowed_for_service_links'] = "EVERYONE";
\$conf['allowed_for_host_search'] = "EVERYONE";
\$conf['allowed_for_host_overview'] = "EVERYONE";
\$conf['allowed_for_pages'] = "EVERYONE";
\$conf['overview-range'] = 1 ;
\$conf['popup-width'] = "300px";
\$conf['ui-theme'] = 'smoothness';
\$conf['lang'] = "en_US";
\$conf['date_fmt'] = "d.m.y G:i";
\$conf['enable_recursive_template_search'] = 0;
\$conf['show_xml_icon'] = 1;
\$conf['use_fpdf'] = 1;	
\$conf['background_pdf'] = '/etc/nagios/background.pdf' ;
\$conf['use_calendar'] = 1;
\$views[0]["title"] = "4 Hours";
\$views[0]["start"] = ( 60*60*4 );
\$views[1]["title"] = "24 Hours";
\$views[1]["start"] = ( 60*60*24 );
\$views[2]["title"] = "One Week";
\$views[2]["start"] = ( 60*60*24*7 );
\$views[3]["title"] = "One Month";
\$views[3]["start"] = ( 60*60*24*30 );
\$views[4]["title"] = "One Year";
\$views[4]["start"] = ( 60*60*24*365 );
\$conf['RRD_DAEMON_OPTS'] = '';
\$conf['template_dir'] = '/usr/local/share/pnp4nagios';
?>
EOF

cat <<EOF > /etc/$HTTPD/conf.d/pnp4nagios.conf
Alias /pnp4nagios "/usr/local/share/pnp4nagios"

<Directory "/usr/local/share/pnp4nagios">
   	AllowOverride None
   	Order allow,deny
   	Allow from all
   	#
   	# Use the same value as defined in nagios.conf
   	#
   	AuthName "Nagios Access"
   	AuthType Basic
   	AuthUserFile /etc/nagios/htpasswd
   	Require valid-user
	<IfModule mod_rewrite.c>
		# Turn on URL rewriting
		RewriteEngine On
		Options FollowSymLinks
		# Installation directory
		RewriteBase /pnp4nagios/
		# Protect application and system files from being viewed
		RewriteRule ^(application|modules|system) - [F,L]
		# Allow any files or directories that exist to be displayed directly
		RewriteCond %{REQUEST_FILENAME} !-f
		RewriteCond %{REQUEST_FILENAME} !-d
		# Rewrite all other URLs to index.php/URL
		RewriteRule .* index.php/\$0 [PT,L]
	</IfModule>
</Directory>
EOF



chown -R root.root pages *.pdf pnp4nagios_release *.cfg
popd


mkdir -p /etc/init.d
cat <<EOF > /etc/init.d/npcd
#!/bin/sh

# chkconfig: 345 98 02
# description: PNP4Nagios NCPD

### BEGIN INIT INFO
# Provides:       npcd
# Required-Start: $networking
# Required-Stop:  $networking
# Default-Start:  2 3 5
# Default-Stop:
# Description:    Start NPCD of PNP4Nagios
### END INIT INFO

case "\$1" in
    start)
	# make sure, directories are there (ramdisk!)
	mkdir -p /var/spool/nagios/pnp/npcd
	chown -R nagios.nagios /var/spool/nagios
 	echo -n 'Starting NPCD...'
	/usr/local/bin/npcd -d -f /etc/nagios/npcd.cfg && echo OK || echo Error
        ;;
    stop)
	echo -n 'Stopping NPCD...'
	killall npcd && echo OK || echo Error
    ;;
    restart)
	\$0 stop
	\$0 start
    ;;
    *)
	echo "Usage: \0 {start|stop|restart}"
    ;;
esac
EOF
chmod 755 /etc/init.d/npcd

activate_initd npcd
/etc/init.d/npcd start

echo "Enabling mod_rewrite"
a2enmod rewrite || true

rm -f /usr/local/share/pnp4nagios/install.php

# Und auch noch Nagvis
heading "NagVis"
[ -e nagvis-$NAGVIS_VERSION.tar.gz ] || wget "$NAGVIS_URL"
rm -rf nagvis-$NAGVIS_VERSION
tar xzf nagvis-$NAGVIS_VERSION.tar.gz
pushd nagvis-$NAGVIS_VERSION
rm -rf /usr/local/share/nagvis
./install.sh -q -F -c y \
  -u $WWWUSER \
  -g $WWWGROUP \
  -w /etc/$HTTPD/conf.d \
  -W /nagvis \
  -B /usr/local/bin/nagios \
  -b /usr/bin \
  -p /usr/local/share/nagvis \
  -B /usr/local/bin
popd

cat <<EOF > /usr/local/share/nagvis/etc/nagvis.ini.php
[paths]
base="/usr/local/share/nagvis/"
htmlbase="/nagvis/"
htmlcgi="/nagios/cgi-bin"

[defaults]
backend="live_1"

[backend_live_1]
backendtype="mklivestatus"
socket="unix:/var/run/nagios/rw/live"
EOF


sed -i -e 's@^;socket="unix:.*@socket="unix:/var/run/nagios/rw/live"@' \
       -e 's@^;backend=.*@backend="live_1"@' \
   /usr/local/share/nagvis/etc/nagvis.ini.php

cat <<EOF > /etc/$HTTPD/conf.d/nagios.conf
RedirectMatch ^/$ /nagios/

Alias /nagvis/ /usr/local/share/nagvis/
<Directory /usr/local/share/nagvis/>
   allow from all
   AuthName "Nagios Access"
   AuthType Basic
   AuthUserFile "/etc/nagios/htpasswd"
   require valid-user 
</Directory>

ScriptAlias /nagios/cgi-bin/ /usr/local/lib/nagios/cgi-bin/
<Directory /usr/local/lib/nagios/cgi-bin/>
   allow from all
   AuthName "Nagios Access"
   AuthType Basic
   AuthUserFile "/etc/nagios/htpasswd"
   require valid-user 
</Directory>

Alias /nagios/ /usr/local/share/nagios/htdocs/
<Directory /usr/local/share/nagios/htdocs/>
   allow from all
   AuthName "Nagios Access"
   AuthType Basic
   AuthUserFile "/etc/nagios/htpasswd"
   require valid-user 
</Directory>
EOF



add_user_to_group $WWWUSER nagios
/etc/init.d/$HTTPD stop
/etc/init.d/$HTTPD start
killall nagios || true
/etc/init.d/nagios start
activate_initd nagios || true

# check_mk
heading "Check_MK"
if [ ! -e check_mk-$CHECK_MK_VERSION.tar.gz ]
then
    wget "$CHECK_MK_URL"
fi
rm -rf check_mk-$CHECK_MK_VERSION
tar xzf check_mk-$CHECK_MK_VERSION.tar.gz
pushd check_mk-$CHECK_MK_VERSION
rm -f ~/.check_mk_setup.conf
rm -rf /var/lib/check_mk /etc/check_mk

# Set some non-default paths which cannot be 
# autodetected
cat <<EOF > ~/.check_mk_setup.conf 
check_icmp_path='/usr/local/lib/nagios/plugins/check_icmp'
rrddir='/var/lib/nagios/rrd'
pnptemplates='/usr/local/share/pnp4nagios/templates'
EOF

./setup.sh --yes
echo 'do_rrd_update = False' >> /etc/check_mk/main.mk
popd

echo "Enabling mod_python"
a2enmod python || true

# Apache neu starten
echo "Restarting apache"
/etc/init.d/$HTTPD restart
activate_initd $HTTPD

# side.html anpassen
HTML='<div class="navsectiontitle">Check_MK</div><div class="navsectionlinks"><ul class="navsectionlinks"><li><a href="/check_mk/filter.py" target="<?php echo $link_target;?>">Filters and Actions</a></li></div></div><div class="navsection"><div class="navsectiontitle">Nagvis</div><div class="navsectionlinks"><ul class="navsectionlinks"><li><a href="/nagvis/" target="<?php echo $link_target;?>">Overview page</a></li></div></div><div class="navsection">'
QUOTE=${HTML//\//\\/}
sed -i "/.*Reports<.*$/i$QUOTE" /usr/local/share/nagios/htdocs/side.php

# Agent fuer localhost
mkdir -p /etc/xinetd.d
cp /usr/share/check_mk/agents/xinetd.conf /etc/xinetd.d/check_mk
mkdir -p /usr/bin
install -m 755 /usr/share/check_mk/agents/check_mk_agent.linux /usr/bin/check_mk_agent
/etc/init.d/xinetd stop || true
/etc/init.d/xinetd start
activate_initd xinetd

cat <<EOF > /etc/check_mk/main.mk
all_hosts = [ 'localhost' ]
do_rrd_update = False
EOF
check_mk -I alltcp
rm /etc/nagios/conf.d/localhost.cfg
check_mk -R

heading "Cleaning up"
rm -f /etc/nagios/*.cfg-*

cat <<EOF

Nagios and the addons have been installed into the following paths:

 /etc/nagios              configuration of Nagios & PNP4Nagios
 /etc/check_mk            configuration of check_mk
 /etc/init.d/nagios       start script for Nagios

 /var/lib/nagios          data directory of Nagios
 /var/spool/nagios        spool files for Nagios (in Ramdisk)
 /var/log/nagios          log files of Nagios
 /var/lib/check_mk        data directory of Check_MK

 /usr/local               programs, scripts, fixed data

Now you can point your browser to to http://localhost/nagios/
and login with 'nagiosadmin' and 'test'.
You can change that password with
# htpasswd /etc/nagios/htpasswd nagiosadmin
EOF
