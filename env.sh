export PATH=$PWD/build/node/bin:$PWD/node_modules/.bin:$PATH

alias server='node main.js -p 1053 -v 2>&1 | bunyan'
alias npm='node `which npm`'
alias test='nodeunit test/*.test.js 2>&1 | bunyan'
